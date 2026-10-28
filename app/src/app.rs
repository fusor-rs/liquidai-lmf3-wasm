use fusor::{JsInputs, Signal, signal};
use serde::{Deserialize, Serialize};

use crate::decision::{self, Decision, Region};
use crate::examples::{EXAMPLES, Example, PRESETS, Preset};
use crate::markdown::{self, Block};

/// Who wrote a message.
#[derive(Clone, Copy, PartialEq)]
enum Role {
    User,
    Model,
}

impl Role {
    fn name(self) -> &'static str {
        match self {
            Self::User => "user",
            Self::Model => "model",
        }
    }
}

/// A message of the conversation as the page shows it, a reply's reasoning apart, a user's
/// message with the count of its images and clips.
#[derive(Clone, PartialEq)]
struct Entry {
    index: usize,
    role: Role,
    text: String,
    reasoning: Option<String>,
    images: usize,
    clips: usize,
}

impl Entry {
    fn new(index: usize, role: Role, text: String) -> Self {
        Self {
            index,
            role,
            text,
            reasoning: None,
            images: 0,
            clips: 0,
        }
    }

    fn images(&self) -> String {
        let count = |count: usize, one: &str| match count {
            0 => None,
            1 => Some(format!("1 {one}")),
            count => Some(format!("{count} {one}s")),
        };
        let media: Vec<String> = [count(self.images, "image"), count(self.clips, "clip")]
            .into_iter()
            .flatten()
            .collect();
        if media.is_empty() {
            return String::new();
        }
        format!("with {}", media.join(" and "))
    }

    fn reasons(&self) -> bool {
        self.reasoning.is_some()
    }

    fn is_user(&self) -> bool {
        self.role == Role::User
    }

    /// A reply's Markdown, drawn.
    fn blocks(&self) -> Vec<Block> {
        markdown::blocks(&self.text)
    }

    fn reasoning(&self) -> String {
        // Shown only for a reply that reasons.
        self.reasoning.clone().unwrap_or_default()
    }
}

/// A model of the collection, from `MODELS` in `web/app.js`, and whether the page loaded it.
#[derive(Clone, PartialEq, Deserialize)]
struct Choice {
    id: String,
    /// Its repository's name under LiquidAI on Hugging Face.
    name: String,
    reads: String,
    images: bool,
    audio: bool,
    /// A decision model: it answers a request's questions, where a chat model replies. Only
    /// decision models carry it.
    #[serde(default)]
    decides: bool,
    current: bool,
}

impl Choice {
    fn link(&self) -> String {
        format!("?id={}", self.id)
    }

    fn label(&self) -> String {
        format!("{} · {}", self.name, self.reads)
    }
}

/// An image added to the next message, as `web/app.js` decoded it.
#[derive(Clone, PartialEq, Deserialize)]
struct Picture {
    index: usize,
    name: String,
    width: u32,
    height: u32,
}

impl Picture {
    fn summary(&self) -> String {
        format!("{} · {}×{}", self.name, self.width, self.height)
    }
}

/// A clip added to the next message, as `web/app.js` decoded it.
#[derive(Clone, PartialEq, Deserialize)]
struct Sound {
    index: usize,
    name: String,
    seconds: f64,
}

impl Sound {
    fn summary(&self) -> String {
        format!("{} · {:.1} s", self.name, self.seconds)
    }
}

/// The runtime's sampling: `lfm3::sampling::Sampling`.
#[derive(Serialize)]
struct Sampling {
    temperature: f64,
    top_p: f64,
    top_k: u32,
    presence_penalty: f64,
}

/// The runtime's message, `lfm3::session::Message`, but its seed, which `web/app.js` draws.
#[derive(Serialize)]
struct Message {
    text: String,
    /// The system text the mode asks for, empty for text.
    system: String,
    /// `lfm3::prompt::Mode`: text, transcribe, speech or interleaved.
    mode: String,
    thinking: bool,
    max_tokens: u32,
    /// None for the model card's settings.
    sampling: Option<Sampling>,
}

// The runtime build and the bundle, once loaded.
#[derive(Clone, PartialEq, Deserialize)]
struct Loaded {
    build: String,
    threads: u32,
    bundle_bytes: f64,
    load_ms: f64,
    // Every part came from this device's storage.
    from_device: bool,
}

impl Loaded {
    fn summary(&self) -> String {
        let threads = match self.threads {
            1 => "1 thread".to_string(),
            count => format!("{count} threads"),
        };
        format!(
            "{} · {threads} · {:.0} MB bundle · model {} in {}",
            self.build,
            self.bundle_bytes / 1e6,
            self.source(),
            self.seconds()
        )
    }

    fn source(&self) -> &'static str {
        if self.from_device {
            "loaded from this device"
        } else {
            "downloaded"
        }
    }

    fn seconds(&self) -> String {
        format!("{:.1} s", self.load_ms / 1000.0)
    }
}

/// Milliseconds as seconds, or a dash before they are measured.
fn elapsed(ms: Option<f64>) -> String {
    ms.map_or("–".into(), |ms| format!("{:.2} s", ms / 1000.0))
}

/// What `web/app.js` measures while a reply is written: the delay from Send to its first token
/// (`first_ms`), the tokens written and the time since that first one (`writing_ms`), the
/// conversation's tokens and the prompt's, which each turn reads whole, and the network requests
/// made since the model loaded.
#[derive(Clone, Default, PartialEq, Deserialize)]
struct Metrics {
    first_ms: Option<f64>,
    tokens: u32,
    writing_ms: f64,
    context_tokens: u32,
    prompt_tokens: u32,
    requests: u32,
}

impl Metrics {
    fn first_token(&self) -> String {
        elapsed(self.first_ms)
    }

    fn speed(&self) -> String {
        if self.tokens < 2 || self.writing_ms == 0.0 {
            return "–".into();
        }
        format!(
            "{:.1}/s",
            f64::from(self.tokens - 1) * 1000.0 / self.writing_ms
        )
    }

    fn tokens(&self) -> String {
        self.tokens.to_string()
    }

    fn context(&self) -> String {
        self.context_tokens.to_string()
    }

    fn read(&self) -> String {
        format!("{} read this turn", self.prompt_tokens)
    }

    fn requests(&self) -> String {
        self.requests.to_string()
    }
}

/// What `web/app.js` measures of a decision model's request: the delay from Send to its answers
/// (`answer_ms`), the tokens its packs read, its packs (the state, then up to the checkpoint's
/// set size of questions), and the network requests made since the model loaded.
#[derive(Clone, Default, PartialEq, Deserialize)]
struct Answering {
    answer_ms: Option<f64>,
    input_tokens: u32,
    packs: u32,
    requests: u32,
}

impl Answering {
    fn answer_time(&self) -> String {
        elapsed(self.answer_ms)
    }

    fn input_tokens(&self) -> String {
        self.input_tokens.to_string()
    }

    fn packs(&self) -> String {
        self.packs.to_string()
    }

    fn requests(&self) -> String {
        self.requests.to_string()
    }
}

// What `web/app.js` reports, one JSON object per `engine` event.
#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum Report {
    Loading {
        fraction: f64,
        detail: String,
    },
    Ready {
        loaded: Loaded,
    },
    // The models the page can load, the one it loads marked.
    Models {
        models: Vec<Choice>,
    },
    // The images added to the next message, after one was added or they were cleared.
    Images {
        images: Vec<Picture>,
    },
    // The clips added to the next message, after one was added or they were removed.
    Clips {
        clips: Vec<Sound>,
    },
    // The microphone started or stopped recording.
    Recording {
        active: bool,
    },
    // The reply so far.
    Reply {
        status: String,
        reasoning: Option<String>,
        answer: String,
        metrics: Metrics,
    },
    // The reply is written, or stopped.
    Done {
        status: String,
        metrics: Metrics,
    },
    // A decision model's next stage.
    Deciding {
        status: String,
    },
    // A decision model's answers in the request's order, none when stopped.
    Decided {
        status: String,
        answers: Vec<Decision>,
        metrics: Answering,
    },
    // Something failed; the engine can take the next message.
    Error {
        message: String,
    },
    // The model could not load, or the engine died: nothing more can run in this page.
    Broken {
        message: String,
    },
}

#[derive(Clone, Copy, PartialEq)]
enum Phase {
    Idle,
    Replying,
    Broken,
}

impl Phase {
    fn name(self) -> &'static str {
        match self {
            Self::Idle => "idle",
            Self::Replying => "replying",
            Self::Broken => "broken",
        }
    }
}

/// The longest reply the page asks for unless told otherwise.
const MAX_TOKENS: u32 = 2048;

#[derive(JsInputs)]
struct App {
    text: Signal<String>,
    thinking: Signal<bool>,
    // How a model that speaks replies: `Message::mode`, and what its system text names.
    mode: Signal<String>,
    asr_language: Signal<String>,
    tts_language: Signal<String>,
    voice: Signal<String>,
    // The model card's settings for the turn, unless the fields below are used.
    card_sampling: Signal<bool>,
    temperature: Signal<f64>,
    top_p: Signal<f64>,
    top_k: Signal<u32>,
    presence_penalty: Signal<f64>,
    max_tokens: Signal<u32>,
    // A decision model's request: its state and its questions, as JSON.
    decision_state: Signal<String>,
    questions: Signal<String>,
    // `web/app.js` acts on every new count: `sends` (Send) sends `message` and the images to the
    // engine, `stops` stops the reply, `resets` starts a new conversation, `clears` removes the
    // images.
    #[js]
    message: Signal<String>,
    #[js]
    sends: Signal<u32>,
    #[js]
    stops: Signal<u32>,
    #[js]
    resets: Signal<u32>,
    #[js]
    clears: Signal<u32>,
    // `records` starts or stops the microphone, `drops` removes the clips.
    #[js]
    records: Signal<u32>,
    #[js]
    drops: Signal<u32>,
    models: Signal<Vec<Choice>>,
    images: Signal<Vec<Picture>>,
    clips: Signal<Vec<Sound>>,
    recording: Signal<bool>,
    phase: Signal<Phase>,
    fraction: Signal<f64>,
    detail: Signal<String>,
    status: Signal<String>,
    entries: Signal<Vec<Entry>>,
    metrics: Signal<Metrics>,
    answers: Signal<Vec<Decision>>,
    answering: Signal<Answering>,
    // The index of the image the boxes are drawn over, the request's first.
    picture: Signal<Option<usize>>,
    loaded: Signal<Option<Loaded>>,
}

impl App {
    fn new() -> Self {
        Self {
            text: signal(String::new()),
            thinking: signal(true),
            mode: signal("text".into()),
            asr_language: signal("English".into()),
            tts_language: signal("American English".into()),
            voice: signal("female".into()),
            card_sampling: signal(true),
            temperature: signal(0.1),
            top_p: signal(1.0),
            top_k: signal(50),
            presence_penalty: signal(0.0),
            max_tokens: signal(MAX_TOKENS),
            decision_state: signal(String::new()),
            questions: signal(String::new()),
            message: signal(String::new()),
            sends: signal(0),
            stops: signal(0),
            resets: signal(0),
            clears: signal(0),
            records: signal(0),
            drops: signal(0),
            models: signal(Vec::new()),
            images: signal(Vec::new()),
            clips: signal(Vec::new()),
            recording: signal(false),
            phase: signal(Phase::Idle),
            fraction: signal(0.0),
            detail: signal("Starting…".into()),
            status: signal("Write a message, or start from an example.".into()),
            entries: signal(Vec::new()),
            metrics: signal(Metrics::default()),
            answers: signal(Vec::new()),
            answering: signal(Answering::default()),
            picture: signal(None),
            loaded: signal(None),
        }
    }

    fn examples(&self) -> Vec<Example> {
        EXAMPLES.to_vec()
    }

    fn pick(&self, example: &Example) {
        self.text.set(example.text.into());
    }

    fn presets(&self) -> Vec<Preset> {
        PRESETS.to_vec()
    }

    fn pick_preset(&self, preset: &Preset) {
        self.decision_state.set(preset.state.into());
        self.questions.set(preset.questions.into());
    }

    /// The system text a model that speaks takes for the mode: as its model card writes it.
    fn system(&self) -> String {
        match self.mode.get().as_str() {
            "transcribe" => format!("Perform ASR in {}.", self.asr_language.get()),
            "speech" => format!(
                "Perform TTS in {} using a {} voice.",
                self.tts_language.get(),
                self.voice.get()
            ),
            "interleaved" => "Respond with interleaved text and audio.".into(),
            _ => String::new(),
        }
    }

    fn send(&self) {
        if self.decides() {
            return self.decide();
        }
        let text = self.text.get();
        let clips = self.clips.get().len();
        if text.trim().is_empty() && clips == 0 {
            return self.status.set("Write a message first.".into());
        }
        let sampling = (!self.card_sampling.get()).then(|| Sampling {
            temperature: self.temperature.get(),
            top_p: self.top_p.get(),
            top_k: self.top_k.get(),
            presence_penalty: self.presence_penalty.get(),
        });
        let message = Message {
            text: text.clone(),
            system: self.system(),
            mode: self.mode.get(),
            thinking: self.thinking.get(),
            max_tokens: self.max_tokens.get(),
            sampling,
        };
        self.message
            .set(serde_json::to_string(&message).expect("a message serializes"));
        let images = self.images.get().len();
        self.entries.update(|entries| {
            let index = entries.len();
            entries.push(Entry {
                images,
                clips,
                ..Entry::new(index, Role::User, text)
            });
            entries.push(Entry::new(index + 1, Role::Model, String::new()));
        });
        self.text.set(String::new());
        self.metrics.set(Metrics::default());
        self.dispatch(
            "Reading the conversation…",
            "Replying once the model is ready.",
        );
    }

    fn decide(&self) {
        let request = match decision::request(&self.decision_state.get(), &self.questions.get()) {
            Ok(request) => request,
            Err(problem) => return self.status.set(problem),
        };
        self.message.set(request);
        self.picture
            .set(self.images.get().first().map(|image| image.index));
        self.answers.set(Vec::new());
        self.answering.set(Answering::default());
        self.dispatch("Reading the request…", "Answering once the model is ready.");
    }

    /// Hands `message` to `web/app.js`, with the status for a loaded model or one still loading.
    fn dispatch(&self, loaded: &str, loading: &str) {
        self.phase.set(Phase::Replying);
        let status = if self.loaded.get().is_some() {
            loaded
        } else {
            loading
        };
        self.status.set(status.into());
        self.sends.update(|count| *count += 1);
    }

    fn stop(&self) {
        self.stops.update(|count| *count += 1);
    }

    fn clear(&self) {
        self.clears.update(|count| *count += 1);
    }

    fn record(&self) {
        self.records.update(|count| *count += 1);
    }

    fn drop_clips(&self) {
        self.drops.update(|count| *count += 1);
    }

    fn reset(&self) {
        self.entries.set(Vec::new());
        self.metrics.set(Metrics::default());
        self.status.set("A new conversation.".into());
        self.resets.update(|count| *count += 1);
    }

    fn receive(&self, event: web_sys::Event) {
        let json = fusor::js::event_detail::<String>(&event).expect("web/app.js sends strings");
        let report = serde_json::from_str(&json).expect("web/app.js sends engine reports");
        match report {
            Report::Loading { fraction, detail } => {
                self.fraction.set(fraction);
                self.detail.set(detail);
            }
            Report::Ready { loaded } => self.loaded.set(Some(loaded)),
            Report::Models { models } => {
                self.models.set(models);
                if self.decides() {
                    let status = "Write the state and the questions, or start from an example.";
                    self.status.set(status.into());
                }
            }
            Report::Images { images } => self.images.set(images),
            Report::Clips { clips } => self.clips.set(clips),
            Report::Recording { active } => self.recording.set(active),
            Report::Reply {
                status,
                reasoning,
                answer,
                metrics,
            } => {
                self.entries.update(|entries| {
                    let reply = entries.last_mut().expect("a reply follows its message");
                    reply.text = answer;
                    reply.reasoning = reasoning;
                });
                self.status.set(status);
                self.metrics.set(metrics);
            }
            Report::Done { status, metrics } => {
                self.status.set(status);
                self.metrics.set(metrics);
                self.phase.set(Phase::Idle);
            }
            Report::Deciding { status } => self.status.set(status),
            Report::Decided {
                status,
                answers,
                metrics,
            } => {
                self.answers.set(answers);
                self.answering.set(metrics);
                self.status.set(status);
                self.phase.set(Phase::Idle);
            }
            Report::Error { message } => {
                self.status.set(format!("error: {message}"));
                self.phase.set(Phase::Idle);
            }
            Report::Broken { message } => {
                self.detail.set(message);
                self.phase.set(Phase::Broken);
            }
        }
    }

    /// The model the page loads, once `web/app.js` named it.
    fn current(&self) -> Option<Choice> {
        self.models.get().into_iter().find(|model| model.current)
    }

    fn reads_images(&self) -> bool {
        self.current().is_some_and(|model| model.images)
    }

    fn hears(&self) -> bool {
        self.current().is_some_and(|model| model.audio)
    }

    fn decides(&self) -> bool {
        self.current().is_some_and(|model| model.decides)
    }

    fn picture_index(&self) -> String {
        self.picture
            .get()
            .map_or(String::new(), |index| index.to_string())
    }

    fn regions(&self) -> Vec<Region> {
        decision::regions(&self.answers.get())
    }

    fn load_time(&self) -> String {
        self.loaded
            .get()
            .map_or("–".into(), |loaded| loaded.seconds())
    }

    fn load_source(&self) -> &'static str {
        self.loaded
            .get()
            .map_or("while the model loads", |loaded| loaded.source())
    }

    fn transcribes(&self) -> bool {
        self.mode.get() == "transcribe"
    }

    fn speaks(&self) -> bool {
        self.mode.get() == "speech"
    }

    fn record_label(&self) -> &'static str {
        if self.recording.get() {
            "Stop recording"
        } else {
            "Record from the microphone"
        }
    }

    fn clips_summary(&self) -> String {
        match self.clips.get().len() {
            0 => "No clip: the message is not spoken.".into(),
            1 => "1 clip goes with the next message.".into(),
            count => format!("{count} clips go with the next message."),
        }
    }

    fn model_name(&self) -> String {
        self.current().map_or(String::new(), |model| model.name)
    }

    fn model_card(&self) -> String {
        self.current().map_or(String::new(), |model| {
            format!("https://huggingface.co/LiquidAI/{}", model.name)
        })
    }

    fn model_license(&self) -> String {
        self.current().map_or(String::new(), |model| {
            format!("/model/{}/LICENSE", model.id)
        })
    }

    fn images_summary(&self) -> String {
        match self.images.get().len() {
            0 => "No image: the message is text only.".into(),
            1 => "1 image goes with the next message.".into(),
            count => format!("{count} images go with the next message."),
        }
    }

    fn summary(&self) -> String {
        self.loaded
            .get()
            .map_or(String::new(), |loaded| loaded.summary())
    }

    fn loading(&self) -> bool {
        self.loaded.get().is_none() && self.phase.get() != Phase::Broken
    }

    // The model never loaded: likely a bundle that does not match the runtime.
    fn failed_to_load(&self) -> bool {
        self.loaded.get().is_none()
    }

    fn idle(&self) -> bool {
        self.phase.get() == Phase::Idle
    }

    fn send_label(&self) -> &'static str {
        match self.phase.get() {
            Phase::Replying => "Replying…",
            _ if self.loaded.get().is_none() => "Send now, replies when ready",
            _ => "Send",
        }
    }

    fn empty(&self) -> bool {
        self.entries.get().is_empty()
    }
}

fusor::template!("web/index.html");
