//! The LFM3 page. The conversation, the next message (its text and how to reply), a decision
//! model's request and answers, and the live measurements are signals here; `web/app.js` runs
//! the engine worker and reports back through `engine` events.

mod app;
mod decision;
mod examples;
mod markdown;
