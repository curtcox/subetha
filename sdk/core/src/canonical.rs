//! Canonical JSON (spec §3): a strict subset of RFC 8785 (JCS).
//!
//! Mirrors `sdk/js/src/protocol/canonical.ts`. Rules:
//! keys sorted by code point, no whitespace, minimal string escaping, integers only
//! (|n| <= 2^53 - 1), `null` members dropped from objects (kept in arrays), keys must be
//! printable ASCII.
//!
//! Number handling matches the TypeScript reference, which only sees IEEE doubles after
//! `JSON.parse`: a JSON number is accepted iff its value is a safe integer. That means
//! integral literals such as `1.0`, `1e2`, or `-0` are accepted and emitted as `1`, `100`, `0`
//! (exactly what the TS reference produces), while `1.5`, `1e-7`, and `9007199254740993` are
//! rejected.

use serde_json::{Map, Value};

use crate::Error;

/// 2^53 - 1, the largest integer every JSON implementation represents exactly.
pub const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;

/// Fields excluded from the canonical form of an envelope (spec §3).
pub const NON_CANONICAL_FIELDS: [&str; 2] = ["sig", "hops"];

fn escape_into(out: &mut String, s: &str) {
    out.push('"');
    for ch in s.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{08}' => out.push_str("\\b"),
            '\u{0c}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => {
                out.push_str(&format!("\\u{:04x}", c as u32));
            }
            c => out.push(c),
        }
    }
    out.push('"');
}

/// Returns the canonical integer for a JSON number, or an error if it is not a safe integer.
pub fn safe_integer(n: &serde_json::Number) -> Result<i64, Error> {
    if let Some(i) = n.as_i64() {
        if (-MAX_SAFE_INTEGER..=MAX_SAFE_INTEGER).contains(&i) {
            return Ok(i);
        }
    } else if n.as_u64().is_some() {
        // Larger than i64::MAX, certainly unsafe.
    } else if let Some(f) = n.as_f64() {
        if f.is_finite() && f.fract() == 0.0 && f.abs() <= MAX_SAFE_INTEGER as f64 {
            // `as` maps -0.0 to 0.
            return Ok(f as i64);
        }
    }
    Err(Error::Canonical(format!("non-integer or unsafe number: {n}")))
}

fn write_value(out: &mut String, v: &Value) -> Result<(), Error> {
    match v {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => out.push_str(&safe_integer(n)?.to_string()),
        Value::String(s) => escape_into(out, s),
        Value::Array(a) => {
            out.push('[');
            for (i, x) in a.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_value(out, x)?;
            }
            out.push(']');
        }
        Value::Object(m) => write_object(out, m, &[])?,
    }
    Ok(())
}

fn write_object(out: &mut String, m: &Map<String, Value>, skip: &[&str]) -> Result<(), Error> {
    let mut keys: Vec<&String> = m
        .iter()
        .filter(|(k, v)| !v.is_null() && !skip.contains(&k.as_str()))
        .map(|(k, _)| k)
        .collect();
    // Byte order == code point order for UTF-8; keys are ASCII anyway.
    keys.sort_unstable_by(|a, b| a.as_bytes().cmp(b.as_bytes()));
    out.push('{');
    for (i, k) in keys.iter().enumerate() {
        if !k.bytes().all(|b| (0x20..=0x7e).contains(&b)) {
            return Err(Error::Canonical(format!("non-ASCII object key: {k}")));
        }
        if i > 0 {
            out.push(',');
        }
        escape_into(out, k);
        out.push(':');
        write_value(out, &m[k.as_str()])?;
    }
    out.push('}');
    Ok(())
}

/// Serializes a JSON value canonically.
pub fn canonicalize(value: &Value) -> Result<String, Error> {
    let mut out = String::new();
    write_value(&mut out, value)?;
    Ok(out)
}

/// Canonical form of an envelope for signing and E2EE AAD: drops `sig` and `hops`.
pub fn canonical_envelope(env: &Map<String, Value>) -> Result<String, Error> {
    let mut out = String::new();
    write_object(&mut out, env, &NON_CANONICAL_FIELDS)?;
    Ok(out)
}

/// Canonical form of an object with the given top-level fields removed.
pub fn canonical_object_without(obj: &Map<String, Value>, skip: &[&str]) -> Result<String, Error> {
    let mut out = String::new();
    write_object(&mut out, obj, skip)?;
    Ok(out)
}

/// Parses JSON text and canonicalizes it.
pub fn canonicalize_str(json: &str) -> Result<String, Error> {
    let v: Value = serde_json::from_str(json).map_err(|e| Error::Canonical(e.to_string()))?;
    canonicalize(&v)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn sorts_and_drops_nulls() {
        let v = json!({"b": 1, "a": null, "A": [null, true], "_": {"z": "x", "y": null}});
        assert_eq!(canonicalize(&v).unwrap(), r#"{"A":[null,true],"_":{"z":"x"},"b":1}"#);
        assert_eq!(canonicalize(&Value::Null).unwrap(), "null");
    }

    #[test]
    fn escapes() {
        let v = json!("a\"b\\c\n\r\t\u{8}\u{c}\u{0}\u{1f}\u{7f}é🚪/");
        assert_eq!(
            canonicalize(&v).unwrap(),
            "\"a\\\"b\\\\c\\n\\r\\t\\b\\f\\u0000\\u001f\u{7f}é🚪/\""
        );
    }

    #[test]
    fn numbers() {
        assert_eq!(canonicalize_str("[0,-0,-1,9007199254740991,-9007199254740991]").unwrap(), "[0,0,-1,9007199254740991,-9007199254740991]");
        assert_eq!(canonicalize_str("[1.0,1e2,-0.0]").unwrap(), "[1,100,0]");
        for bad in ["1.5", "1e-7", "9007199254740992", "9007199254740993", "-9007199254740992", "18446744073709551615", "1e300"] {
            assert!(canonicalize_str(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn keys_must_be_printable_ascii() {
        assert!(canonicalize_str(r#"{"é":1}"#).is_err());
        assert!(canonicalize_str("{\"a\\n\":1}").is_err());
        // A null member with a bad key is dropped before the check, as in TS.
        assert_eq!(canonicalize_str(r#"{"é":null}"#).unwrap(), "{}");
    }

    #[test]
    fn envelope_drops_sig_and_hops() {
        let v = json!({"topic": "@a/b", "sig": "x", "hops": 3, "message": "m"});
        assert_eq!(canonical_envelope(v.as_object().unwrap()).unwrap(), r#"{"message":"m","topic":"@a/b"}"#);
    }
}
