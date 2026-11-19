// A small JSON reader and writer for the corpus runner, keeping each number's own text
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

//! The corpus is JSON, and the library has no runtime dependencies, so the test reads it with this reader (about 150 lines) instead of a crate.
//!
//! A number keeps both its parsed value and its text. Comparing a number means comparing the text the reference printed with the text the Rust side prints, which is stricter than comparing values.

#![allow(dead_code)]

/// A parsed JSON value.
#[derive(Clone, Debug, PartialEq)]
pub enum Json {
	Null,
	Bool(bool),
	/// The number's text exactly as written, and its value.
	Num(String, f64),
	Str(String),
	Arr(Vec<Json>),
	/// Fields in file order.
	Obj(Vec<(String, Json)>),
}

impl Json {
	pub fn get(&self, key: &str) -> Option<&Json> {
		match self {
			Json::Obj(fields) => fields.iter().find(|(k, _)| k == key).map(|(_, v)| v),
			_ => None,
		}
	}

	pub fn as_str(&self) -> Option<&str> {
		match self {
			Json::Str(s) => Some(s),
			_ => None,
		}
	}

	pub fn as_arr(&self) -> Option<&[Json]> {
		match self {
			Json::Arr(items) => Some(items),
			_ => None,
		}
	}

	pub fn as_f64(&self) -> Option<f64> {
		match self {
			Json::Num(_, n) => Some(*n),
			_ => None,
		}
	}

	/// The compact text `JSON.stringify` would write for this value.
	pub fn to_compact(&self) -> String {
		let mut out = String::new();
		self.write(&mut out);
		out
	}

	fn write(&self, out: &mut String) {
		match self {
			Json::Null => out.push_str("null"),
			Json::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
			Json::Num(text, _) => out.push_str(text),
			Json::Str(s) => write_string(s, out),
			Json::Arr(items) => {
				out.push('[');
				for (i, item) in items.iter().enumerate() {
					if i > 0 {
						out.push(',');
					}
					item.write(out);
				}
				out.push(']');
			}
			Json::Obj(fields) => {
				out.push('{');
				for (i, (key, value)) in fields.iter().enumerate() {
					if i > 0 {
						out.push(',');
					}
					write_string(key, out);
					out.push(':');
					value.write(out);
				}
				out.push('}');
			}
		}
	}
}

/// Writes a string the way `JSON.stringify` does.
pub fn write_string(s: &str, out: &mut String) {
	out.push('"');
	for c in s.chars() {
		match c {
			'"' => out.push_str("\\\""),
			'\\' => out.push_str("\\\\"),
			'\u{8}' => out.push_str("\\b"),
			'\u{c}' => out.push_str("\\f"),
			'\n' => out.push_str("\\n"),
			'\r' => out.push_str("\\r"),
			'\t' => out.push_str("\\t"),
			c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
			c => out.push(c),
		}
	}
	out.push('"');
}

/// Reads one JSON document.
pub fn parse(text: &str) -> Result<Json, String> {
	let mut reader = Reader {
		bytes: text.as_bytes(),
		pos: 0,
	};
	let value = reader.value()?;
	reader.skip_ws();
	if reader.pos != reader.bytes.len() {
		return Err(format!("trailing text at byte {}", reader.pos));
	}
	Ok(value)
}

struct Reader<'a> {
	bytes: &'a [u8],
	pos: usize,
}

impl Reader<'_> {
	fn skip_ws(&mut self) {
		while self.pos < self.bytes.len() && self.bytes[self.pos].is_ascii_whitespace() {
			self.pos += 1;
		}
	}

	fn eat(&mut self, byte: u8) -> Result<(), String> {
		self.skip_ws();
		if self.bytes.get(self.pos) == Some(&byte) {
			self.pos += 1;
			Ok(())
		} else {
			Err(format!("expected {:?} at byte {}", byte as char, self.pos))
		}
	}

	fn value(&mut self) -> Result<Json, String> {
		self.skip_ws();
		match self.bytes.get(self.pos) {
			Some(b'{') => {
				self.pos += 1;
				let mut fields = Vec::new();
				self.skip_ws();
				if self.bytes.get(self.pos) == Some(&b'}') {
					self.pos += 1;
					return Ok(Json::Obj(fields));
				}
				loop {
					self.skip_ws();
					let key = self.string()?;
					self.eat(b':')?;
					fields.push((key, self.value()?));
					self.skip_ws();
					match self.bytes.get(self.pos) {
						Some(b',') => self.pos += 1,
						Some(b'}') => {
							self.pos += 1;
							return Ok(Json::Obj(fields));
						}
						_ => return Err(format!("bad object at byte {}", self.pos)),
					}
				}
			}
			Some(b'[') => {
				self.pos += 1;
				let mut items = Vec::new();
				self.skip_ws();
				if self.bytes.get(self.pos) == Some(&b']') {
					self.pos += 1;
					return Ok(Json::Arr(items));
				}
				loop {
					items.push(self.value()?);
					self.skip_ws();
					match self.bytes.get(self.pos) {
						Some(b',') => self.pos += 1,
						Some(b']') => {
							self.pos += 1;
							return Ok(Json::Arr(items));
						}
						_ => return Err(format!("bad array at byte {}", self.pos)),
					}
				}
			}
			Some(b'"') => Ok(Json::Str(self.string()?)),
			Some(b't') => self.word("true", Json::Bool(true)),
			Some(b'f') => self.word("false", Json::Bool(false)),
			Some(b'n') => self.word("null", Json::Null),
			Some(_) => {
				let start = self.pos;
				while self.pos < self.bytes.len()
					&& matches!(
						self.bytes[self.pos],
						b'-' | b'+' | b'.' | b'e' | b'E' | b'0'..=b'9'
					) {
					self.pos += 1;
				}
				let text = std::str::from_utf8(&self.bytes[start..self.pos]).unwrap();
				let value: f64 = text.parse().map_err(|_| format!("bad number {text:?}"))?;
				Ok(Json::Num(text.to_string(), value))
			}
			None => Err("unexpected end".into()),
		}
	}

	fn word(&mut self, word: &str, value: Json) -> Result<Json, String> {
		if self.bytes[self.pos..].starts_with(word.as_bytes()) {
			self.pos += word.len();
			Ok(value)
		} else {
			Err(format!("bad literal at byte {}", self.pos))
		}
	}

	fn string(&mut self) -> Result<String, String> {
		if self.bytes.get(self.pos) != Some(&b'"') {
			return Err(format!("expected a string at byte {}", self.pos));
		}
		self.pos += 1;
		let mut out: Vec<u16> = Vec::new();
		loop {
			let Some(&byte) = self.bytes.get(self.pos) else {
				return Err("unterminated string".into());
			};
			self.pos += 1;
			match byte {
				b'"' => return Ok(String::from_utf16_lossy(&out)),
				b'\\' => {
					let escape = self.bytes[self.pos];
					self.pos += 1;
					match escape {
						b'"' => out.push(0x22),
						b'\\' => out.push(0x5c),
						b'/' => out.push(0x2f),
						b'b' => out.push(8),
						b'f' => out.push(12),
						b'n' => out.push(10),
						b'r' => out.push(13),
						b't' => out.push(9),
						b'u' => {
							let hex =
								std::str::from_utf8(&self.bytes[self.pos..self.pos + 4]).unwrap();
							out.push(u16::from_str_radix(hex, 16).map_err(|e| e.to_string())?);
							self.pos += 4;
						}
						other => return Err(format!("bad escape {:?}", other as char)),
					}
				}
				_ => {
					// Copy one whole UTF-8 character.
					let start = self.pos - 1;
					let len = match byte {
						0..=0x7f => 1,
						0xc0..=0xdf => 2,
						0xe0..=0xef => 3,
						_ => 4,
					};
					let text = std::str::from_utf8(&self.bytes[start..start + len]).unwrap();
					out.extend(text.encode_utf16());
					self.pos = start + len;
				}
			}
		}
	}
}
