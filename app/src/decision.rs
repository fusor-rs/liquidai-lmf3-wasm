//! A decision model's request, composed from the page's state and questions, and its answers as
//! `web/app.js` reports them: one card per question, and the boxes drawn over the picture.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::value::{RawValue, to_raw_value};

/// `d1_runtime.start`'s request: the questions as written, so that they keep their order, and no
/// state when the media are the whole state.
#[derive(Serialize)]
struct Request {
    #[serde(skip_serializing_if = "Option::is_none")]
    state: Option<Box<RawValue>>,
    questions: Box<RawValue>,
}

/// The request for the page's `state`, JSON when it parses as JSON and else text, and its
/// `questions`; an error naming the problem when the questions are not JSON.
pub(crate) fn request(state: &str, questions: &str) -> Result<String, String> {
    let questions = serde_json::from_str(questions)
        .map_err(|problem| format!("The questions are not JSON: {problem}."))?;
    let state = (!state.trim().is_empty()).then(|| {
        // A state that does not parse as JSON is text.
        serde_json::from_str(state)
            .unwrap_or_else(|_| to_raw_value(state).expect("a string serializes"))
    });
    let request = Request { state, questions };
    Ok(serde_json::to_string(&request).expect("a request serializes"))
}

#[derive(Clone, PartialEq, Deserialize)]
pub(crate) struct Decision {
    pub(crate) name: String,
    answer: Answer,
}

/// An answer as the runtime writes it, by its question's `type`.
#[derive(Clone, PartialEq, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum Answer {
    Noul {
        noul: f64,
    },
    Choice(Choice),
    Score {
        score: f64,
        confidence: f64,
        probabilities: BTreeMap<String, f64>,
        legend: BTreeMap<String, String>,
    },
    Text(Read),
    Date(Date),
    Number(Number),
    Box {
        #[serde(rename = "box")]
        edges: Option<Edges>,
        found: f64,
        confidence: f64,
    },
    Boxes {
        boxes: Vec<Instance>,
        count: usize,
        at_least: bool,
    },
}

#[derive(Clone, PartialEq, Deserialize)]
#[serde(untagged)]
enum Choice {
    One {
        choice: String,
        confidence: f64,
        probabilities: BTreeMap<String, f64>,
    },
    /// Every option at a P(yes) of one half or more, and each option's P(yes).
    Many {
        choices: Vec<String>,
        probabilities: BTreeMap<String, f64>,
    },
}

#[derive(Clone, PartialEq, Deserialize)]
#[serde(untagged)]
enum Number {
    /// The median over the question's range, and the central 80 percent interval.
    Estimate {
        number: f64,
        interval: [f64; 2],
        unit: Option<String>,
    },
    Read {
        number: Option<f64>,
        #[serde(flatten)]
        read: Read,
    },
}

/// A date read from the state: its ISO value, when the text read settles one.
#[derive(Clone, PartialEq, Deserialize)]
struct Date {
    date: Option<String>,
    #[serde(flatten)]
    read: Read,
}

/// A span read from the state: its text, its characters, and its JSON path in a JSON state.
#[derive(Clone, PartialEq, Deserialize)]
struct Read {
    text: Option<String>,
    span: Option<[usize; 2]>,
    found: f64,
    path: Option<String>,
    unit: Option<String>,
}

/// A box's edges, as fractions of the picture.
#[derive(Clone, Copy, PartialEq, Deserialize)]
struct Edges {
    top: f64,
    bottom: f64,
    left: f64,
    right: f64,
}

#[derive(Clone, PartialEq, Deserialize)]
struct Instance {
    #[serde(rename = "box")]
    edges: Edges,
}

/// One option's or level's probability.
#[derive(Clone, PartialEq)]
pub(crate) struct Bar {
    pub(crate) index: usize,
    pub(crate) label: String,
    pub(crate) share: f64,
}

impl Bar {
    pub(crate) fn percent(&self) -> String {
        format!("{:.0}%", self.share * 100.0)
    }
}

/// A box drawn over the picture, labelled by its question's name.
#[derive(Clone, PartialEq)]
pub(crate) struct Region {
    pub(crate) index: usize,
    pub(crate) label: String,
    edges: Edges,
}

impl Region {
    pub(crate) fn style(&self) -> String {
        let Edges {
            top,
            bottom,
            left,
            right,
        } = self.edges;
        let percent = |fraction: f64| fraction * 100.0;
        format!(
            "top: {:.2}%; left: {:.2}%; height: {:.2}%; width: {:.2}%",
            percent(top),
            percent(left),
            percent(bottom - top),
            percent(right - left)
        )
    }
}

impl Decision {
    pub(crate) fn kind(&self) -> &'static str {
        match &self.answer {
            Answer::Noul { .. } => "noul",
            Answer::Choice(_) => "choice",
            Answer::Score { .. } => "score",
            Answer::Text(_) => "text",
            Answer::Date(_) => "date",
            Answer::Number(_) => "number",
            Answer::Box { .. } => "box",
            Answer::Boxes { .. } => "boxes",
        }
    }

    pub(crate) fn headline(&self) -> String {
        match &self.answer {
            Answer::Noul { noul } => format!("P(yes) = {noul:.2}"),
            Answer::Choice(Choice::One { choice, .. }) => choice.clone(),
            Answer::Choice(Choice::Many { choices, .. }) if choices.is_empty() => {
                "None of them".into()
            }
            Answer::Choice(Choice::Many { choices, .. }) => choices.join(", "),
            Answer::Score { score, legend, .. } => {
                format!("{score}: {}", legend[&score.to_string()])
            }
            Answer::Text(read) => read.headline(None),
            Answer::Date(Date { date, read }) => read.headline(date.clone()),
            Answer::Number(Number::Read { number, read }) => {
                read.headline(number.map(|number| measured(number, read.unit.as_deref())))
            }
            Answer::Number(Number::Estimate { number, unit, .. }) => {
                measured(*number, unit.as_deref())
            }
            Answer::Box { edges: Some(_), .. } => "Drawn on the picture".into(),
            Answer::Box { edges: None, .. } => "Not in the picture".into(),
            Answer::Boxes {
                count,
                at_least: true,
                ..
            } => format!("At least {count}, drawn on the picture"),
            Answer::Boxes { count, .. } => format!("{count}, drawn on the picture"),
        }
    }

    /// A choice's options, likeliest first, a score's levels, lowest first, or a noul's yes.
    pub(crate) fn bars(&self) -> Vec<Bar> {
        let shares: Vec<(String, f64)> = match &self.answer {
            Answer::Noul { noul } => vec![("yes".into(), *noul)],
            Answer::Choice(
                Choice::One { probabilities, .. } | Choice::Many { probabilities, .. },
            ) => {
                let mut shares: Vec<(String, f64)> = probabilities
                    .iter()
                    .map(|(name, &share)| (name.clone(), share))
                    .collect();
                shares.sort_by(|first, second| second.1.total_cmp(&first.1));
                shares
            }
            Answer::Score {
                probabilities,
                legend,
                ..
            } => legend
                .iter()
                .zip(probabilities.values())
                .map(|((level, text), &share)| (format!("{level} · {text}"), share))
                .collect(),
            _ => Vec::new(),
        };
        let bars = shares.into_iter().enumerate();
        bars.map(|(index, (label, share))| Bar {
            index,
            label,
            share,
        })
        .collect()
    }

    /// What the headline leaves out: a confidence, a read's span, an estimate's interval.
    pub(crate) fn detail(&self) -> String {
        match &self.answer {
            Answer::Choice(Choice::One { confidence, .. }) | Answer::Score { confidence, .. } => {
                format!("confidence {confidence:.2}")
            }
            Answer::Choice(Choice::Many { .. }) => {
                "every option at a P(yes) of one half or more".into()
            }
            Answer::Text(read)
            | Answer::Date(Date { read, .. })
            | Answer::Number(Number::Read { read, .. }) => read.detail(),
            Answer::Number(Number::Estimate {
                interval: [low, high],
                unit,
                ..
            }) => format!(
                "80% between {} and {}",
                measured(*low, None),
                measured(*high, unit.as_deref())
            ),
            Answer::Box {
                found, confidence, ..
            } => format!("found {found:.2} · confidence {confidence:.2}"),
            Answer::Noul { .. } | Answer::Boxes { .. } => String::new(),
        }
    }

    /// The boxes the answer found: a box's under its name, every instance's numbered.
    fn regions(&self) -> Vec<(String, Edges)> {
        match &self.answer {
            Answer::Box {
                edges: Some(edges), ..
            } => vec![(self.name.clone(), *edges)],
            Answer::Boxes { boxes, .. } => boxes
                .iter()
                .zip(1..)
                .map(|(instance, number)| (format!("{} {number}", self.name), instance.edges))
                .collect(),
            _ => Vec::new(),
        }
    }
}

impl Read {
    /// The value parsed from the text read beside it, or the text alone.
    fn headline(&self, value: Option<String>) -> String {
        match (value, &self.text) {
            (_, None) => "Not found".into(),
            (Some(value), Some(text)) => format!("{value} · “{text}”"),
            (None, Some(text)) => format!("“{text}”"),
        }
    }

    fn detail(&self) -> String {
        let span = self
            .span
            .map(|[start, end]| format!("characters {start} to {end} of the state"));
        let path = self.path.as_ref().map(|path| format!("at {path}"));
        let unit = self.unit.as_ref().map(|unit| format!("in {unit}"));
        let found = Some(format!("found {:.2}", self.found));
        let parts: Vec<String> = [span, path, unit, found].into_iter().flatten().collect();
        parts.join(" · ")
    }
}

/// A number to two decimals at most, with its unit when it has one.
fn measured(value: f64, unit: Option<&str>) -> String {
    let fixed = format!("{value:.2}");
    let number = fixed.trim_end_matches('0').trim_end_matches('.');
    match unit {
        Some(unit) => format!("{number} {unit}"),
        None => number.to_owned(),
    }
}

/// Every box the answers found, in their order.
pub(crate) fn regions(decisions: &[Decision]) -> Vec<Region> {
    let found = decisions.iter().flat_map(Decision::regions).enumerate();
    found
        .map(|(index, (label, edges))| Region {
            index,
            label,
            edges,
        })
        .collect()
}
