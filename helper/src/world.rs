//! The typst world of one project: library, fonts, project and package files, and the clock.
//!
//! Adapted from typst-cli 0.15.1 crates/typst-cli/src/world.rs (Apache-2.0).

use std::any::Any;
use std::collections::{BTreeMap, HashSet};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use typst::diag::FileResult;
use typst::foundations::{Bytes, Datetime, Dict, Duration, IntoValue};
use typst::syntax::package::PackageSpec;
use typst::syntax::{
    FileId, PathError, RootedPath, Source, VirtualPath, VirtualRoot, VirtualizeError,
};
use typst::text::{Font, FontBook};
use typst::utils::LazyHash;
use typst::{Library, LibraryExt, World};
use typst_ide::IdeWorld;
use typst_kit::datetime::Time;
use typst_kit::downloader::{
    Downloader, Progress, ProgressDownloader, ProgressReporter, SystemDownloader,
};
use typst_kit::files::{FileLoader, FileStore, FsRoot};
use typst_kit::fonts::FontStore;
use typst_kit::packages::SystemPackages;

use crate::lines;
use crate::protocol::Position;

/// A world that provides access to the operating system for one project. Between compilations it holds the files as the last compilation read them; lookups resolve the spans of the last successful document against these sources, whose span numbers stay stable for unchanged text.
pub struct HelperWorld {
    /// Typst's standard library.
    library: LazyHash<Library>,
    /// Extra font folders.
    font_paths: Vec<PathBuf>,
    /// Discovered fonts, scanned on first use.
    fonts: OnceLock<FontStore>,
    /// Maps file ids to source files and buffers.
    files: FileStore<ProjectFiles>,
    /// The current datetime if requested. This is stored here to ensure it is always the same within one compilation. Reset between compilations if not fixed.
    now: Time,
    /// The fixed creation timestamp (`SOURCE_DATE_EPOCH`), if any.
    creation_timestamp: Option<i64>,
    /// The files requested as Typst sources since the last reset.
    sources_requested: Mutex<HashSet<FileId>>,
    /// The project files the last compilation read as Typst sources.
    sources_read: Vec<FileId>,
}

/// What a byte offset into a file was measured in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OffsetBase {
    /// The text of the parsed source: offsets from syntax nodes and numbered spans. A byte order mark is not part of it, as in the editor.
    Source,
    /// The raw bytes of the file: offsets from range spans into files that are not Typst sources.
    Bytes,
}

impl HelperWorld {
    /// Creates the world for the entry file `main` in the project folder `root`. Fails when either does not exist or `main` is not inside `root`.
    pub fn new(
        root: &Path,
        main: &Path,
        font_paths: &[PathBuf],
        inputs: &BTreeMap<String, String>,
    ) -> Result<HelperWorld, String> {
        let real_root = root.canonicalize().map_err(|err| match err.kind() {
            io::ErrorKind::NotFound => {
                format!("root directory not found (searched at {})", root.display())
            }
            _ => format!("cannot access root directory {} ({err})", root.display()),
        })?;
        if !real_root.is_dir() {
            return Err(format!("root is not a directory ({})", root.display()));
        }
        let real_main = main.canonicalize().map_err(|err| match err.kind() {
            io::ErrorKind::NotFound => {
                format!("input file not found (searched at {})", main.display())
            }
            _ => format!("cannot access input file {} ({err})", main.display()),
        })?;

        // Keep the caller's spelling of the root when the entry lies under it, so that reported paths are the ones the editor uses; otherwise compare the canonical paths as typst-cli does.
        let (root, vpath) = match root
            .is_absolute()
            .then(|| VirtualPath::virtualize(root, main))
        {
            Some(Ok(vpath)) => (root.to_path_buf(), vpath),
            _ => {
                let vpath =
                    VirtualPath::virtualize(&real_root, &real_main).map_err(virtualize_error)?;
                (real_root, vpath)
            }
        };

        let library = {
            // Convert the input pairs to a dictionary.
            let inputs: Dict = inputs
                .iter()
                .map(|(k, v)| (k.as_str().into(), v.as_str().into_value()))
                .collect();
            Library::builder().with_inputs(inputs).build()
        };

        Ok(HelperWorld {
            library: LazyHash::new(library),
            font_paths: font_paths.to_vec(),
            fonts: OnceLock::new(),
            files: FileStore::new(ProjectFiles {
                main: RootedPath::new(VirtualRoot::Project, vpath).intern(),
                project: FsRoot::new(root),
                packages: SystemPackages::new(downloader()),
            }),
            now: Time::system(),
            creation_timestamp: None,
            sources_requested: Mutex::new(HashSet::new()),
            sources_read: Vec::new(),
        })
    }

    /// Fixes the time as typst-cli's `--creation-timestamp` (`SOURCE_DATE_EPOCH`) does: `today()` gives the date of this UNIX timestamp in UTC and the PDF creation timestamp is this time in UTC. `None` uses the current time.
    pub fn set_creation_timestamp(&mut self, timestamp: Option<i64>) -> Result<(), String> {
        self.now = match timestamp {
            Some(seconds) => Time::fixed_timestamp(seconds)
                .map_err(|_| "creation timestamp out of range".to_string())?,
            None => Time::system(),
        };
        self.creation_timestamp = timestamp;
        Ok(())
    }

    /// The fixed creation timestamp, if any.
    pub fn creation_timestamp(&self) -> Option<i64> {
        self.creation_timestamp
    }

    /// The line and UTF-16 character of a byte offset into a file, measured in its parsed source or in its raw bytes.
    pub fn position(&self, id: FileId, offset: usize, base: OffsetBase) -> Option<Position> {
        Some(match base {
            OffsetBase::Source => lines::byte_to_position(self.source(id).ok()?.text(), offset),
            OffsetBase::Bytes => {
                let bytes = self.file(id).ok()?;
                lines::byte_to_position(&String::from_utf8_lossy(bytes.as_slice()), offset)
            }
        })
    }

    /// The project root relative to which absolute paths are resolved.
    pub fn root(&self) -> &Path {
        self.files.loader().project.path()
    }

    /// Resets the compilation state in preparation of a new compilation: changed files are read again, unchanged sources keep their parse, and `today()` is fetched again.
    pub fn reset(&mut self) {
        self.files.reset();
        self.now.reset();
        self.sources_requested
            .get_mut()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clear();
    }

    /// The paths of the project files (not package files) the last compilation tried to read, sorted. Call it after each compilation; it also records the files for [`Self::sources_read`].
    pub fn dependencies(&mut self) -> Vec<PathBuf> {
        let (loader, ids) = self.files.dependencies();
        let read: Vec<FileId> = ids
            .filter(|id| matches!(id.root(), VirtualRoot::Project))
            .collect();
        let mut paths: Vec<PathBuf> = read
            .iter()
            .filter_map(|id| loader.project.resolve(id.vpath()).ok())
            .collect();
        paths.sort();
        paths.dedup();
        let requested = self
            .sources_requested
            .get_mut()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        self.sources_read = read
            .into_iter()
            .filter(|id| requested.contains(id))
            .collect();
        paths
    }

    /// The project files the last compilation read as Typst sources (whatever their extension), as recorded by [`Self::dependencies`].
    pub fn sources_read(&self) -> &[FileId] {
        &self.sources_read
    }

    /// The path of a project file, or of a package file in the package data or cache directory.
    pub fn path_of(&self, id: FileId) -> Option<PathBuf> {
        let root = match id.root() {
            VirtualRoot::Project => self.files.loader().project.clone(),
            VirtualRoot::Package(spec) => self.files.loader().installed_package(spec)?,
        };
        root.resolve(id.vpath()).ok()
    }

    /// Whether the file belongs to the project (not to a package).
    pub fn is_project_file(&self, id: FileId) -> bool {
        matches!(id.root(), VirtualRoot::Project)
    }

    /// The id of the project file at `path` (absolute, as the root's spelling or canonical); `None` outside the project.
    pub fn project_file(&self, path: &Path) -> Option<FileId> {
        let vpath = VirtualPath::virtualize(self.root(), path)
            .ok()
            .or_else(|| {
                let real_root = self.root().canonicalize().ok()?;
                VirtualPath::virtualize(&real_root, &path.canonicalize().ok()?).ok()
            })?;
        Some(RootedPath::new(VirtualRoot::Project, vpath).intern())
    }

    /// The fonts, discovered on first use.
    fn fonts(&self) -> &FontStore {
        self.fonts
            .get_or_init(|| crate::fonts::discover_fonts(&self.font_paths))
    }
}

impl World for HelperWorld {
    fn library(&self) -> &LazyHash<Library> {
        &self.library
    }

    fn book(&self) -> &LazyHash<FontBook> {
        self.fonts().book()
    }

    fn main(&self) -> FileId {
        self.files.loader().main
    }

    fn source(&self, id: FileId) -> FileResult<Source> {
        self.sources_requested
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(id);
        self.files.source(id)
    }

    fn file(&self, id: FileId) -> FileResult<Bytes> {
        self.files.file(id)
    }

    fn font(&self, index: usize) -> Option<Font> {
        self.fonts().font(index)
    }

    fn today(&self, offset: Option<Duration>) -> Option<Datetime> {
        self.now.today(offset)
    }
}

impl IdeWorld for HelperWorld {
    fn upcast(&self) -> &dyn World {
        self
    }
}

/// Provides project files from the project root and package files from the standard package directories, downloading `@preview` packages from Typst Universe into the cache.
struct ProjectFiles {
    main: FileId,
    project: FsRoot,
    packages: SystemPackages,
}

impl ProjectFiles {
    /// Resolves the root in which the given file ID resides.
    fn root(&self, id: FileId) -> FileResult<FsRoot> {
        Ok(match id.root() {
            VirtualRoot::Project => self.project.clone(),
            VirtualRoot::Package(spec) => self.packages.obtain(spec)?,
        })
    }

    /// The root of a package that is already in the data or cache directory (never downloads).
    fn installed_package(&self, spec: &PackageSpec) -> Option<FsRoot> {
        let data = self
            .packages
            .data()
            .and_then(|packages| packages.obtain(spec));
        data.or_else(|| {
            self.packages
                .cache()
                .and_then(|packages| packages.obtain(spec))
        })
    }
}

impl FileLoader for ProjectFiles {
    fn load(&self, id: FileId) -> FileResult<Bytes> {
        self.root(id)?.load(id.vpath())
    }
}

/// The package downloader: Typst Universe over HTTPS with this helper's user agent; progress goes to stderr.
fn downloader() -> impl Downloader {
    let user_agent = format!("typst-workshop-helper/{}", crate::HELPER_VERSION);
    ProgressDownloader::new(SystemDownloader::new(user_agent), |key: &dyn Any| {
        DownloadLog(
            key.downcast_ref::<PackageSpec>()
                .map(|spec| spec.to_string()),
        )
    })
}

/// Logs package downloads to stderr.
struct DownloadLog(Option<String>);

impl ProgressReporter for DownloadLog {
    fn start(&mut self, _: &Progress) {
        if let Some(name) = &self.0 {
            eprintln!("downloading {name}");
        }
    }

    fn update(&mut self, _: &Progress) {}

    fn finish(&mut self, progress: &Progress) {
        if let Some(name) = &self.0 {
            eprintln!("downloaded {name}: {progress}");
        }
    }
}

/// The message typst-cli gives for an entry path that cannot be placed in the project.
fn virtualize_error(err: VirtualizeError) -> String {
    match err {
        VirtualizeError::Path(PathError::Escapes) => {
            "source file must be contained in project root".into()
        }
        VirtualizeError::Path(PathError::Backslash) => {
            "source path must not contain a backslash".into()
        }
        VirtualizeError::Invalid(s) => format!("source path contains invalid sequence `{s}`"),
        VirtualizeError::Utf8 => "source path must be valid UTF-8".into(),
    }
}
