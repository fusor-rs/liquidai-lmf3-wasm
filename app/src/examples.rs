//! The messages, and a decision model's requests, the page offers to start from.

/// An example message.
#[derive(Clone, PartialEq)]
pub(crate) struct Example {
    pub(crate) id: &'static str,
    pub(crate) label: &'static str,
    pub(crate) text: &'static str,
}

pub(crate) const EXAMPLES: [Example; 3] = [
    Example {
        id: "colors",
        label: "A question",
        text: "Name the three primary colors of light, in one sentence.",
    },
    Example {
        id: "trains",
        label: "A puzzle",
        text: "A train leaves at 9:40 and arrives at 13:15. How long is the trip?",
    },
    Example {
        id: "haiku",
        label: "A haiku",
        text: "Write a haiku about a browser tab that thinks.",
    },
];

/// An example request of a decision model: its state and its questions, as the page's fields
/// hold them.
#[derive(Clone, PartialEq)]
pub(crate) struct Preset {
    pub(crate) id: &'static str,
    pub(crate) label: &'static str,
    pub(crate) state: &'static str,
    pub(crate) questions: &'static str,
}

pub(crate) const PRESETS: [Preset; 3] = [
    Preset {
        id: "ticket",
        label: "Triage a ticket",
        state: "I was charged twice and my parcel never arrived. Please refund one charge.",
        questions: include_str!("presets/ticket.json"),
    },
    Preset {
        id: "invoice",
        label: "Read an invoice",
        state: "ACME SA
Invoice 2026-117
Total due: 1 234,50 EUR
Pay before 03/04/2026 (day/month/year)",
        questions: include_str!("presets/invoice.json"),
    },
    Preset {
        id: "picture",
        label: "Find things in the picture",
        state: "",
        questions: include_str!("presets/picture.json"),
    },
];
