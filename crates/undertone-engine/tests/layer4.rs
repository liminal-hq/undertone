// Compares the in-house renderer with the browser renders of layer 4 and reports every measured difference
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

//! Layer 4 (`docs/rust-migration/CONFORMANCE.md`): each case of `conformance/cases/4/renders.json` is rendered
//! through [`undertone_engine::render_graph::RenderGraph`] from its recorded score and reduced to the same
//! summary the browser run made (`conformance/recorder/renderSummary.ts`: per channel RMS, peak, RMS in eight
//! octave bands from one FFT of the whole channel, RMS per 100 ms window), and the two are compared in
//! decibels.
//!
//! The test **measures**: it prints one table of every case's differences (`--nocapture`), writes the same
//! tables in Markdown to the file named by `LAYER4_RESULTS` when that is set, and asserts only a loose guard
//! ([`GUARD_DB`]) so that a gross break fails. The proposed tolerances are reported next to each figure but do not
//! fail the test. A band or a window below [`FLOOR`] in both renders is not compared (it is more than 80 dB
//! under full scale, where a reverb tail or a filter's skirt differs for reasons nobody can hear). Nothing in
//! it was listened to.

mod common;

use common::render_case_frames;
use serde_json::Value;
use std::fmt::Write as _;
use std::path::Path;

/// The loosest difference, in decibels, the test lets through for the channel RMS and peak while the true figures are recorded.
const GUARD_DB: f64 = 3.0;
/// The same for a band or a window, which are compared at levels down to -80 dBFS, where the browser's own quirks show (a
/// voice that starts inside a render quantum has another phase there, see `R-layer4.md`), so the guard is wider.
const GUARD_DB_QUIET: f64 = 12.0;
/// Linear amplitude under which a band or window pair is not compared (-80 dBFS).
const FLOOR: f64 = 1e-4;
/// The bands' upper edges in Hz (`BAND_EDGES` in `renderSummary.ts`).
const BAND_EDGES: [f64; 7] = [125.0, 250.0, 500.0, 1000.0, 2000.0, 4000.0, 8000.0];
/// A window's length in seconds.
const WINDOW_SECONDS: f64 = 0.1;

/// The proposed tolerances (`CONFORMANCE.md`), in decibels.
struct Tolerance {
	rms: f64,
	peak: f64,
	band: f64,
	window: f64,
}

/// The master limiter off (measured in the plan) and on (proposed). With the limiter on, only the peak and the
/// RMS have a proposed figure; the band and window figures are reported against the limiter-off numbers.
fn tolerance(limiter_on: bool) -> Tolerance {
	if limiter_on {
		Tolerance {
			rms: 0.05,
			peak: 0.1,
			band: 0.1,
			window: 0.05,
		}
	} else {
		Tolerance {
			rms: 0.01,
			peak: 0.02,
			band: 0.1,
			window: 0.05,
		}
	}
}

/// Prints a list of numbers in one line with the given format.
struct Show<'a>(&'a [f64]);

impl std::fmt::LowerExp for Show<'_> {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		for value in self.0 {
			std::fmt::LowerExp::fmt(value, f)?;
			f.write_str(" ")?;
		}
		Ok(())
	}
}

/// One channel's summary.
struct Channel {
	rms: f64,
	peak: f64,
	bands: Vec<f64>,
	windows: Vec<f64>,
}

fn numbers(value: &Value) -> Vec<f64> {
	value
		.as_array()
		.expect("an array")
		.iter()
		.map(|x| x.as_f64().expect("a number"))
		.collect()
}

fn browser_channels(case: &Value) -> Vec<Channel> {
	case["browser"]["channels"]
		.as_array()
		.expect("browser channels")
		.iter()
		.map(|c| Channel {
			rms: c["rms"].as_f64().expect("rms"),
			peak: c["peak"].as_f64().expect("peak"),
			bands: numbers(&c["bands"]),
			windows: numbers(&c["windows"]),
		})
		.collect()
}

/// In-place radix-2 FFT, the same algorithm as `renderSummary.ts`.
fn fft(re: &mut [f64], im: &mut [f64]) {
	let n = re.len();
	let mut j = 0;
	for i in 1..n {
		let mut bit = n >> 1;
		while j & bit != 0 {
			j ^= bit;
			bit >>= 1;
		}
		j ^= bit;
		if i < j {
			re.swap(i, j);
			im.swap(i, j);
		}
	}
	let mut len = 2;
	while len <= n {
		let half = len >> 1;
		for k in 0..half {
			let angle = -2.0 * std::f64::consts::PI * k as f64 / len as f64;
			let (wi, wr) = angle.sin_cos();
			let mut start = 0;
			while start < n {
				let a = start + k;
				let b = a + half;
				let tr = re[b] * wr - im[b] * wi;
				let ti = re[b] * wi + im[b] * wr;
				re[b] = re[a] - tr;
				im[b] = im[a] - ti;
				re[a] += tr;
				im[a] += ti;
				start += len;
			}
		}
		len <<= 1;
	}
}

fn summarise(samples: &[f32], sample_rate: f64) -> Channel {
	let frames = samples.len();
	let mut peak = 0.0_f64;
	let mut sum = 0.0_f64;
	for &sample in samples {
		let value = f64::from(sample);
		peak = peak.max(value.abs());
		sum += value * value;
	}
	let size = frames.next_power_of_two();
	let mut re = vec![0.0; size];
	let mut im = vec![0.0; size];
	for (slot, &sample) in re.iter_mut().zip(samples) {
		*slot = f64::from(sample);
	}
	fft(&mut re, &mut im);
	let mut power = [0.0_f64; 8];
	for k in 1..size / 2 {
		let hz = k as f64 * sample_rate / size as f64;
		let band = BAND_EDGES.iter().take_while(|&&edge| hz >= edge).count();
		power[band] += re[k] * re[k] + im[k] * im[k];
	}
	let bands = power
		.iter()
		.map(|p| (2.0 * p / (frames as f64 * size as f64)).sqrt())
		.collect();
	let window = ((WINDOW_SECONDS * sample_rate).round() as usize).max(1);
	let windows = samples
		.chunks(window)
		.map(|chunk| {
			let sum: f64 = chunk.iter().map(|&s| f64::from(s).powi(2)).sum();
			(sum / chunk.len() as f64).sqrt()
		})
		.collect();
	Channel {
		rms: (sum / frames.max(1) as f64).sqrt(),
		peak,
		bands,
		windows,
	}
}

/// `20 log10(rust / browser)`; zero for two equal values, infinite when only one is zero.
fn db(rust: f64, browser: f64) -> f64 {
	if rust == browser {
		0.0
	} else if rust == 0.0 {
		f64::NEG_INFINITY
	} else if browser == 0.0 {
		f64::INFINITY
	} else {
		20.0 * (rust / browser).log10()
	}
}

/// The largest difference by magnitude in a list (keeping its sign) and where it is.
#[derive(Clone, Copy, Default)]
struct Worst {
	db: f64,
	at: usize,
}

impl Worst {
	fn take(&mut self, db: f64, at: usize) {
		if db.abs() > self.db.abs() || (db.is_nan() && !self.db.is_nan()) {
			*self = Worst { db, at };
		}
	}
}

/// What was measured for one case, in decibels (Rust minus browser, so positive is louder in Rust).
struct Measured {
	id: String,
	limiter_on: bool,
	rms: Worst,
	peak: Worst,
	band: Worst,
	window: Worst,
	/// The differences of every band, the worst over the channels.
	band_by_index: [f64; 8],
	compared_bands: usize,
	compared_windows: usize,
	frames: usize,
}

fn compare(id: &str, limiter_on: bool, rust: &[Channel], browser: &[Channel]) -> Measured {
	let mut m = Measured {
		id: id.to_string(),
		limiter_on,
		rms: Worst::default(),
		peak: Worst::default(),
		band: Worst::default(),
		window: Worst::default(),
		band_by_index: [0.0; 8],
		compared_bands: 0,
		compared_windows: 0,
		frames: 0,
	};
	assert_eq!(rust.len(), browser.len(), "{id}: channel count");
	for (c, (r, b)) in rust.iter().zip(browser).enumerate() {
		m.rms.take(db(r.rms, b.rms), c);
		m.peak.take(db(r.peak, b.peak), c);
		assert_eq!(r.bands.len(), b.bands.len(), "{id}: band count");
		for (i, (&x, &y)) in r.bands.iter().zip(&b.bands).enumerate() {
			if x.max(y) >= FLOOR {
				let d = db(x, y);
				m.band.take(d, i);
				if d.abs() > m.band_by_index[i].abs() {
					m.band_by_index[i] = d;
				}
				m.compared_bands += 1;
			}
		}
		assert_eq!(r.windows.len(), b.windows.len(), "{id}: window count");
		for (i, (&x, &y)) in r.windows.iter().zip(&b.windows).enumerate() {
			if x.max(y) >= FLOOR {
				m.window.take(db(x, y), i);
				m.compared_windows += 1;
			}
		}
	}
	m
}

fn flag(measured: f64, tolerance: f64) -> &'static str {
	if measured.abs() <= tolerance {
		""
	} else {
		" X"
	}
}

fn render_tables(results: &[Measured]) -> String {
	let mut out = String::new();
	out.push_str(
		"| case | limiter | RMS dB | peak dB | band dB (band) | window dB (window) | bands / windows compared |\n",
	);
	out.push_str("| --- | --- | ---: | ---: | ---: | ---: | --- |\n");
	for m in results {
		let t = tolerance(m.limiter_on);
		let _ = writeln!(
			out,
			"| `{}` | {} | {:+.4}{} | {:+.4}{} | {:+.3}{} ({}) | {:+.3}{} ({}) | {} / {} |",
			m.id,
			if m.limiter_on { "on" } else { "off" },
			m.rms.db,
			flag(m.rms.db, t.rms),
			m.peak.db,
			flag(m.peak.db, t.peak),
			m.band.db,
			flag(m.band.db, t.band),
			m.band.at,
			m.window.db,
			flag(m.window.db, t.window),
			m.window.at,
			m.compared_bands,
			m.compared_windows,
		);
	}
	out.push_str("\nPer band, the worst difference over the channels (dB; `.` below the floor in both renders):\n\n");
	out.push_str("| case | <125 | 125 | 250 | 500 | 1k | 2k | 4k | >=8k |\n");
	out.push_str("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |\n");
	for m in results {
		let cells: Vec<String> = m
			.band_by_index
			.iter()
			.map(|d| {
				if *d == 0.0 {
					".".to_string()
				} else {
					format!("{d:+.2}")
				}
			})
			.collect();
		let _ = writeln!(out, "| `{}` | {} |", m.id, cells.join(" | "));
	}
	out
}

#[test]
fn rust_renders_match_the_browser_summaries_within_a_loose_guard() {
	let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../conformance/cases/4/renders.json");
	let file: Value = serde_json::from_str(&std::fs::read_to_string(path).expect("reads"))
		.expect("the corpus file is JSON");
	let mut results = Vec::new();
	let mut version = String::new();
	for case in file["cases"].as_array().expect("cases") {
		let id = case["id"].as_str().expect("id");
		let frames = case["browser"]["frames"].as_u64().expect("frames");
		version = case["browser"]["chromium"]
			.as_str()
			.expect("chromium")
			.to_string();
		let sample_rate = case["browser"]["sampleRate"].as_f64().expect("sampleRate");
		let rendered = render_case_frames(case, Some(frames)).expect("the booking works");
		assert!(
			rendered.channels.iter().flatten().all(|s| s.is_finite()),
			"{id}: a sample is not finite"
		);
		// LAYER4_DUMP=<directory> writes each case's samples (little-endian f32, one file per channel) to compare with a browser's.
		if let Ok(dir) = std::env::var("LAYER4_DUMP") {
			for (c, samples) in rendered.channels.iter().enumerate() {
				let bytes: Vec<u8> = samples.iter().flat_map(|s| s.to_le_bytes()).collect();
				std::fs::write(Path::new(&dir).join(format!("{id}.rust.ch{c}.f32")), bytes)
					.expect("writes the samples");
			}
		}
		let rust: Vec<Channel> = rendered
			.channels
			.iter()
			.map(|c| summarise(c, sample_rate))
			.collect();
		let browser = browser_channels(case);
		if std::env::var("LAYER4_VERBOSE").is_ok() {
			for (c, (r, b)) in rust.iter().zip(&browser).enumerate() {
				println!("{id} ch{c} rms rust {:.6e} browser {:.6e}", r.rms, b.rms);
				println!("  bands rust    {:.3e}", Show(&r.bands));
				println!("  bands browser {:.3e}", Show(&b.bands));
			}
		}
		let limiter_on = case["render"]["master"] != Value::Bool(false);
		let mut measured = compare(id, limiter_on, &rust, &browser);
		measured.frames = frames as usize;
		results.push(measured);
	}
	// A file with no cases, or a case that compares nothing, must fail rather than pass every guard.
	assert!(!results.is_empty(), "the layer 4 file holds no cases");
	for m in &results {
		assert!(
			m.compared_bands > 0 && m.compared_windows > 0,
			"{}: nothing was compared (bands {}, windows {})",
			m.id,
			m.compared_bands,
			m.compared_windows
		);
	}
	let tables = render_tables(&results);
	println!("Chromium {version}\n\n{tables}");
	if let Ok(path) = std::env::var("LAYER4_RESULTS") {
		std::fs::write(path, format!("Chromium {version}\n\n{tables}"))
			.expect("writes the results");
	}
	for m in &results {
		for (what, worst, guard) in [
			("RMS", m.rms, GUARD_DB),
			("peak", m.peak, GUARD_DB),
			("band", m.band, GUARD_DB_QUIET),
			("window", m.window, GUARD_DB_QUIET),
		] {
			assert!(
				worst.db.abs() <= guard,
				"{}: {what} differs by {:+.3} dB (guard {guard} dB)",
				m.id,
				worst.db
			);
		}
	}
}
