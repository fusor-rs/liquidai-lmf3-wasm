//! A reply's Markdown as the page draws it: paragraphs, headings, list items, fenced code and
//! rules, each a run of plain, strong, emphasized and code spans. Anything else stays as its text.

const FENCE: &str = "```";
const RULE: &str = "---";

/// What a block of a reply is.
#[derive(Clone, Copy, PartialEq)]
pub(crate) enum Kind {
    Paragraph,
    Heading,
    Item,
    Code,
    Rule,
}

impl Kind {
    pub(crate) fn name(self) -> &'static str {
        match self {
            Self::Paragraph => "paragraph",
            Self::Heading => "heading",
            Self::Item => "item",
            Self::Code => "code",
            Self::Rule => "rule",
        }
    }
}

#[derive(Clone, Copy, PartialEq)]
pub(crate) enum Style {
    Plain,
    Strong,
    Emphasis,
    Code,
}

impl Style {
    pub(crate) fn name(self) -> &'static str {
        match self {
            Self::Plain => "plain",
            Self::Strong => "strong",
            Self::Emphasis => "emphasis",
            Self::Code => "code",
        }
    }
}

#[derive(Clone, PartialEq)]
pub(crate) struct Span {
    pub(crate) index: usize,
    pub(crate) style: Style,
    pub(crate) text: String,
}

#[derive(Clone, PartialEq)]
pub(crate) struct Block {
    pub(crate) index: usize,
    pub(crate) kind: Kind,
    pub(crate) spans: Vec<Span>,
}

/// The blocks of `text`, a fence left open drawn as code to the end.
pub(crate) fn blocks(text: &str) -> Vec<Block> {
    let mut blocks = Vec::new();
    let mut lines = text.lines();
    let mut paragraph: Vec<&str> = Vec::new();
    while let Some(line) = lines.next() {
        let trimmed = line.trim();
        let kind = line_kind(trimmed);
        if kind != Some(Kind::Paragraph) {
            push(&mut blocks, Kind::Paragraph, &paragraph.join("\n"));
            paragraph.clear();
        }
        match kind {
            None => {}
            Some(Kind::Paragraph) => paragraph.push(line),
            Some(Kind::Code) => {
                let code: Vec<&str> = lines
                    .by_ref()
                    .take_while(|line| line.trim() != FENCE)
                    .collect();
                push(&mut blocks, Kind::Code, &code.join("\n"));
            }
            Some(Kind::Rule) => push(&mut blocks, Kind::Rule, ""),
            Some(kind) => push(
                &mut blocks,
                kind,
                trimmed.trim_start_matches('#').trim_start(),
            ),
        }
    }
    push(&mut blocks, Kind::Paragraph, &paragraph.join("\n"));
    blocks
}

/// What a trimmed line starts, `None` for a blank one.
fn line_kind(line: &str) -> Option<Kind> {
    let ordered = line.split_once(". ").is_some_and(|(number, _)| {
        !number.is_empty() && number.bytes().all(|byte| byte.is_ascii_digit())
    });
    match line {
        "" => None,
        RULE => Some(Kind::Rule),
        _ if line.starts_with(FENCE) => Some(Kind::Code),
        _ if line.starts_with('#') && line.trim_start_matches('#').starts_with(' ') => {
            Some(Kind::Heading)
        }
        _ if line.starts_with("- ") || line.starts_with("* ") || ordered => Some(Kind::Item),
        _ => Some(Kind::Paragraph),
    }
}

fn push(blocks: &mut Vec<Block>, kind: Kind, text: &str) {
    if text.is_empty() && kind != Kind::Rule {
        return;
    }
    let spans = match kind {
        Kind::Code => vec![span(0, Style::Code, text)],
        // An ordered item keeps its number.
        Kind::Item => spans(
            text.strip_prefix("- ")
                .or(text.strip_prefix("* "))
                .unwrap_or(text),
        ),
        _ => spans(text),
    };
    blocks.push(Block {
        index: blocks.len(),
        kind,
        spans,
    });
}

/// The spans of a block's text: `**strong**`, `*emphasis*` and `` `code` ``, each only when
/// closed; an unclosed marker stays as text.
fn spans(text: &str) -> Vec<Span> {
    let markers = [
        ("**", Style::Strong),
        ("`", Style::Code),
        ("*", Style::Emphasis),
    ];
    let mut spans = Vec::new();
    let mut plain = String::new();
    let mut rest = text;
    while !rest.is_empty() {
        let closed = markers.iter().find_map(|&(marker, style)| {
            let inner = rest.strip_prefix(marker)?;
            let end = closing(inner, marker)?;
            Some((style, &inner[..end], &inner[end + marker.len()..]))
        });
        if let Some((style, inner, after)) = closed {
            flush(&mut spans, &mut plain);
            spans.push(span(spans.len(), style, inner));
            rest = after;
            continue;
        }
        let character = rest.chars().next().expect("the rest is not empty");
        plain.push(character);
        rest = &rest[character.len_utf8()..];
    }
    flush(&mut spans, &mut plain);
    spans
}

/// Where `marker` closes in `inner`: a run of its character exactly as long, after some text, so
/// that `**VISA ****4421**` is one strong span.
fn closing(inner: &str, marker: &str) -> Option<usize> {
    let character = marker.chars().next().expect("markers are not empty");
    let run = |at: usize| {
        let after = inner[at..]
            .chars()
            .take_while(|&next| next == character)
            .count();
        let joined = inner[..at].ends_with(character);
        (!joined).then_some(after)
    };
    inner
        .match_indices(marker)
        .map(|(at, _)| at)
        .find(|&at| at > 0 && run(at) == Some(marker.len()))
}

fn flush(spans: &mut Vec<Span>, plain: &mut String) {
    if !plain.is_empty() {
        spans.push(span(spans.len(), Style::Plain, plain));
        plain.clear();
    }
}

fn span(index: usize, style: Style, text: &str) -> Span {
    Span {
        index,
        style,
        text: text.to_owned(),
    }
}
