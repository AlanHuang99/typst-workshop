//! One helper session: the project set up by `initialize` and the last successful document, with one method per protocol request.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::Value;
use typst::World;
use typst::syntax::FileId;
use typst_layout::PagedDocument;

use crate::protocol::{
    CompileResult, ForwardParams, ForwardResult, InitializeParams, InitializeResult, InverseParams,
    Position, SourceLocation, WordCountResult,
};
use crate::world::HelperWorld;
use crate::{HELPER_VERSION, TYPST_VERSION, compile, coords, lines, sync, wordcount};

const NOT_INITIALIZED: &str = "not initialized";
const NO_DOCUMENT: &str = "no successful compilation yet";

/// The state of one helper process.
#[derive(Default)]
pub struct Session {
    project: Option<Project>,
}

/// The project of an initialized session.
struct Project {
    world: HelperWorld,
    /// Where the PDF goes.
    output: PathBuf,
    /// The last successful document; lookups answer from it.
    document: Option<PagedDocument>,
    /// The files the project only imports, as of the last successful compilation; the word count leaves them out.
    import_only: HashSet<FileId>,
}

impl Session {
    pub fn new() -> Session {
        Session::default()
    }

    /// Answers one request. Requests other than `initialize` and `shutdown` fail with `not initialized` until `initialize` succeeded.
    pub fn handle(&mut self, method: &str, params: Value) -> Result<Value, String> {
        if !matches!(
            method,
            "initialize" | "compile" | "inverse" | "forward" | "wordCount" | "shutdown"
        ) {
            return Err(format!("unknown method: {method}"));
        }
        if self.project.is_none() && !matches!(method, "initialize" | "shutdown") {
            return Err(NOT_INITIALIZED.into());
        }
        match method {
            "initialize" => to_value(self.initialize(from_params(params)?)?),
            "compile" => to_value(self.compile()?),
            "inverse" => to_value(self.inverse(from_params(params)?)?),
            "forward" => to_value(self.forward(from_params(params)?)?),
            "wordCount" => to_value(self.word_count()?),
            _ => Ok(Value::Null),
        }
    }

    /// The last successful document, if any.
    pub fn document(&self) -> Option<&PagedDocument> {
        self.project.as_ref()?.document.as_ref()
    }

    /// Sets up the project: root, entry file, PDF path, font folders and `sys.inputs`; a `SOURCE_DATE_EPOCH` in the environment fixes the creation timestamp as in typst-cli. A failed `initialize` leaves the session uninitialized.
    pub fn initialize(&mut self, params: InitializeParams) -> Result<InitializeResult, String> {
        self.project = None;
        let font_paths: Vec<PathBuf> = params.font_paths.iter().map(PathBuf::from).collect();
        let mut world = HelperWorld::new(
            Path::new(&params.root),
            Path::new(&params.main),
            &font_paths,
            &params.inputs,
        )?;
        let source_date_epoch = match std::env::var("SOURCE_DATE_EPOCH") {
            Ok(value) => Some(value),
            Err(std::env::VarError::NotPresent) => None,
            Err(std::env::VarError::NotUnicode(_)) => {
                return Err("invalid SOURCE_DATE_EPOCH (not UTF-8)".into());
            }
        };
        world.set_creation_timestamp(compile::creation_timestamp(source_date_epoch.as_deref())?)?;
        let project = self.project.insert(Project {
            world,
            output: PathBuf::from(params.output),
            document: None,
            import_only: HashSet::new(),
        });
        eprintln!(
            "project {} with entry {}, PDF {}",
            project.world.root().display(),
            project.world.main().vpath().get_without_slash(),
            project.output.display()
        );
        Ok(InitializeResult {
            helper_version: HELPER_VERSION.into(),
            typst_version: TYPST_VERSION.into(),
        })
    }

    /// Compiles the project and writes the PDF. On failure the last successful document stays and lookups keep answering from it.
    pub fn compile(&mut self) -> Result<CompileResult, String> {
        let project = self
            .project
            .as_mut()
            .ok_or_else(|| NOT_INITIALIZED.to_string())?;
        let compiled = compile::compile(&mut project.world, &project.output);
        if let Some(document) = compiled.document {
            project.document = Some(document);
            project.import_only = wordcount::import_only_files(&project.world);
        }
        Ok(compiled.result)
    }

    /// The source position for a point on a page of the last successful document; `None` for a page that does not exist or a point far from any content.
    pub fn inverse(&self, params: InverseParams) -> Result<Option<SourceLocation>, String> {
        let (project, document) = self.last_document()?;
        let page = params
            .page
            .checked_sub(1)
            .and_then(|index| document.pages().get(index));
        let Some(page) = page.filter(|_| params.x.is_finite() && params.y.is_finite()) else {
            return Ok(None);
        };
        let click = coords::pdf_to_frame(page, params.x, params.y);
        Ok(
            sync::source_from_click(&project.world, &page.frame, click, &project.import_only)
                .and_then(|target| sync::location(&project.world, target)),
        )
    }

    /// The rectangles in the last successful document that show the text at a cursor position; empty when the file is not part of the project or nothing is found.
    pub fn forward(&self, params: ForwardParams) -> Result<ForwardResult, String> {
        let (project, document) = self.last_document()?;
        let world = &project.world;
        let positions = world
            .project_file(Path::new(&params.path))
            .and_then(|id| world.source(id).ok())
            .map(|source| {
                let cursor = Position {
                    line: params.line,
                    character: params.character,
                };
                let byte = lines::position_to_byte(source.text(), cursor);
                sync::positions_for_cursor(document, &source, byte)
            })
            .unwrap_or_default();
        Ok(ForwardResult { positions })
    }

    /// The words of the user's markup text in the last successful document, by file.
    pub fn word_count(&self) -> Result<WordCountResult, String> {
        let (project, document) = self.last_document()?;
        Ok(wordcount::count(
            &project.world,
            document,
            &project.import_only,
        ))
    }

    fn project(&self) -> Result<&Project, String> {
        self.project
            .as_ref()
            .ok_or_else(|| NOT_INITIALIZED.to_string())
    }

    /// The project and its last successful document.
    fn last_document(&self) -> Result<(&Project, &PagedDocument), String> {
        let project = self.project()?;
        let document = project
            .document
            .as_ref()
            .ok_or_else(|| NO_DOCUMENT.to_string())?;
        Ok((project, document))
    }
}

fn from_params<T: DeserializeOwned>(params: Value) -> Result<T, String> {
    serde_json::from_value(params).map_err(|err| format!("invalid params: {err}"))
}

fn to_value(result: impl Serialize) -> Result<Value, String> {
    serde_json::to_value(result).map_err(|err| format!("cannot serialize result: {err}"))
}
