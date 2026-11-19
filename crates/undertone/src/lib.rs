// The undertone crate: the Rust API of Undertone
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

//! The Rust API of Undertone: patterns, a synth engine, offline rendering, and a scheduler, in one crate.
//!
//! Undertone describes music as **patterns**: functions from a span of cycle time to events, built from
//! mini-notation strings and chained controls, and immutable, so any half-built pattern is safe to reuse. A
//! pattern makes no sound by itself. Sound happens at the end, in one of two ways: **render** it offline to
//! samples and a WAV file, or **play** it on a clock with a [`Player`]. This crate re-exports the three crates
//! underneath ([`pattern`], [`engine`], and [`sched`]) under one surface: [`prelude`] has the names a program
//! needs, [`Error`] is the one error type, and [`Result`] its alias.
//!
//! ```toml
//! [dependencies]
//! undertone = "0.4"
//! ```
//!
//! Nothing here has been listened to by the test suite: it checks node graphs, automation, and rendered
//! numbers against the TypeScript reference's recordings, not how anything sounds.
//!
//! # Getting started
//!
//! Everything a first program needs is in the prelude. A pattern starts with `note`, `sound`, `s`, `n`, or
//! `chord`, takes controls as chained calls (each returns a new pattern, or an [`Error`] for a value the
//! reference would reject, so a typo fails when the pattern is built), and combines with `stack`, `seq`, `cat`,
//! and `arrange`.
//!
//! ```
//! use undertone::prelude::*;
//!
//! // A pattern is data: ask it what it holds without playing it.
//! let pattern = note("c4 e4")?.sound("triangle").gain(0.5)?;
//! let first_half = pattern.query(Span::new(Fraction::from_int(0), Fraction::new(1, 2)));
//! assert_eq!(first_half.len(), 1);
//! assert!(first_half[0].has_onset());
//!
//! // Three layers that start together are one pattern.
//! let hit = stack(vec![
//!     note("c2")?.sound("triangle").decay(0.1)?.lpf(220)?,
//!     note("c6")?.sound("sine").decay(0.15)?.gain(0.3)?.nudge(0.02)?,
//!     sound("white")?.decay(0.02)?.gain(0.4)?.lpf(4000)?,
//! ]);
//! # let _ = hit;
//!
//! // Mistakes are values, with the reference's message.
//! assert_eq!(
//!     note("c4")?.pan(3).unwrap_err().message(),
//!     "pan() position must be between -1 and 1, got 3"
//! );
//! # Ok::<(), undertone::Error>(())
//! ```
//!
//! One example for each page of the guide is under `crates/undertone/examples/`; run the first with
//! `cargo run --example getting_started`.
//!
//! # Render to WAV
//!
//! [`render()`] plans a render from [`RenderOptions`], books every onset of the pattern on a renderer, and gives
//! back a [`RenderedAudio`]: the samples of each channel. [`RenderedAudio::to_wav`] encodes them, and
//! [`render_to_wav`] does both in one call. The tempo is always an explicit option (`bpm`, `cps`, or
//! `default_cpm`): there is no global tempo. A render has no clock, so the same pattern, options, and seed give
//! the same samples on every machine.
//!
//! ```
//! use undertone::prelude::*;
//!
//! let song = note("c3 [e3 g3] <b3 a3> ~")?.sound("triangle").release(0.4)?;
//!
//! // Two cycles at 110 bpm, plus a second of tail so the last release rings out.
//! let options = RenderOptions::new().cycles(2).bpm(110).tail(1).sample_rate(8_000).seed("level-1");
//! let audio = render(&song, &options)?;
//! assert_eq!(audio.channel_count(), 2);
//! assert!(audio.peak() > 0.01);
//!
//! // 24 bit, in one call; write the bytes where you like.
//! let wav = render_to_wav(&song, &options, &WavOptions::new().bit_depth(BitDepth::TwentyFour))?;
//! assert_eq!(&wav[0..4], b"RIFF");
//! # Ok::<(), undertone::Error>(())
//! ```
//!
//! A render is bounded at [`MAX_RENDER_SAMPLES`] (2^28, a gibibyte of `f32`) samples in all channels, on top of the
//! engine's 268,435,456 frames per channel: a larger render, or one the machine cannot hold, returns an error
//! before it renders anything, where the reference would run out of memory (decision D-37, a deliberate
//! difference from the reference, like the engine's other bounds). The bound is on one collected result: a
//! `Player` streams without a lifetime limit, so it can render for as long as it is kept.
//!
//! Samples a pattern plays are decoded PCM that the host registers (decision D-30): Undertone bundles none and
//! fetches nothing. `RenderOptions::register_sample` and `Player::register_sample` take a name, a
//! [`SampleData`], and the pitch the recording sounds at.
//!
//! ```
//! use undertone::prelude::*;
//!
//! let mut options = RenderOptions::new().sample_rate(8_000).seconds(1);
//! options.register_sample("blip", SampleData::new(8_000.0, vec![vec![0.5; 400]]), None)?;
//! let audio = render(&s("blip")?, &options)?;
//! assert!(audio.peak() > 0.01);
//! # Ok::<(), undertone::Error>(())
//! ```
//!
//! # Play with a transport
//!
//! A [`Player`] owns an [`Engine`], a [`Transport`], and a [`Clock`]. [`Player::play`] fires one cycle once (the
//! reference's `.play()`), [`Player::play_loop`] runs a pattern until it is stopped (`.loop()`, with each note
//! gated by its length), [`Player::tick`] books what the look-ahead needs, and [`Player::stop`] and
//! [`Player::shutdown`] end it. [`Player::new`] is the offline player: its clock is moved by the rendering, so
//! asking for two seconds of audio plays two seconds, with the transport ticked on the way.
//!
//! ```
//! use undertone::prelude::*;
//!
//! let mut player = Player::new(&PlayerOptions::new().sample_rate(8_000))?;
//!
//! // The tempo is the player's: 240 bpm is a one-second cycle. An explicit `bpm` on a call always wins.
//! let looping = player.play_loop(
//!     &note("c3 e3 g3 b3")?.sound("triangle"),
//!     &LoopOptions { bpm: Some(240.0), ..LoopOptions::default() },
//! )?;
//! let heard = player.render_seconds(2.0)?;
//! assert_eq!(heard.frames(), 16_000);
//!
//! // Stopping a loop stops the booking; voices already booked ring out (`LoopVoices::Cut` fades them now).
//! player.stop_loop(looping, &LoopStop::default())?;
//! player.shutdown(); // explicit, and harmless to repeat
//! player.shutdown();
//! assert!(player.tick().is_err());
//! # Ok::<(), undertone::Error>(())
//! ```
//!
//! # Writing a host
//!
//! A host is whatever owns the audio: a native callback, a game loop, a Tauri plugin. It brings a [`Graph`]
//! (what the engine books voices on; [`RenderGraph`] renders them to samples) and a [`Clock`] (where its audio
//! is), and calls [`Player::tick`] about every [`SchedulerOptions::tick_interval`] seconds. The crates use no
//! threads and no timers, and read no wall clock, so the host decides all of that.
//!
//! ```
//! use std::sync::Arc;
//! use std::sync::atomic::{AtomicU64, Ordering};
//! use undertone::prelude::*;
//!
//! /// The host's clock: a count of frames its audio callback bumps, read by the scheduler.
//! #[derive(Clone)]
//! struct CallbackClock {
//!     frames: Arc<AtomicU64>,
//!     sample_rate: f64,
//! }
//!
//! impl Clock for CallbackClock {
//!     fn now(&self) -> f64 {
//!         self.frames.load(Ordering::Acquire) as f64 / self.sample_rate
//!     }
//!     fn frames_played(&self) -> u64 {
//!         self.frames.load(Ordering::Acquire)
//!     }
//!     fn output_latency(&self) -> f64 {
//!         0.0
//!     }
//! }
//!
//! let clock = CallbackClock { frames: Arc::new(AtomicU64::new(0)), sample_rate: 8_000.0 };
//! let graph = RenderGraph::new(8_000.0, 2, undertone::engine::render_graph::MAX_RENDER_LENGTH_FRAMES);
//! let setup = OutputSetup::default();
//! let mut player = Player::with_graph(graph, clock.clone(), setup, SchedulerOptions::default())?;
//! player.play_loop(
//!     &note("c3 e3")?.sound("triangle"),
//!     &LoopOptions { bpm: Some(240.0), ..LoopOptions::default() },
//! )?;
//!
//! // The host's audio callback: tick (here every block; a real host ticks every `tick_interval`), render the
//! // block, then move the clock on by the frames played.
//! let mut heard = 0.0_f32;
//! for _ in 0..40 {
//!     player.tick()?;
//!     let (mut left, mut right) = (vec![0.0_f32; 400], vec![0.0_f32; 400]);
//!     let written = player.engine_mut()?.graph_mut().render_block(&mut [&mut left, &mut right]);
//!     heard = heard.max(left.iter().fold(0.0, |peak, s| peak.max(s.abs())));
//!     clock.frames.fetch_add(written as u64, Ordering::Release);
//! }
//! assert!(heard > 0.01);
//! # Ok::<(), undertone::Error>(())
//! ```
//!
//! A host that keeps the player in managed state across async commands (a Tauri plugin, a game's audio
//! service) holds it behind a `Mutex`: [`Player`] is `Send`, and its [`shutdown`](Player::shutdown) is
//! idempotent, so a command that arrives after the app closed gets an [`ErrorKind::Closed`] error, not a
//! crash. `Engine<RenderGraph>` and the pattern types are `Send` too (compile-time assertions in
//! `tests/thread_safety.rs`).
//!
//! # Where things live
//!
//! | Module | What it is |
//! | --- | --- |
//! | [`prelude`] | The curated flat surface: `use undertone::prelude::*;` |
//! | [`pattern`] | [`Fraction`], [`Pattern`], mini-notation, controls, signals, scales, chords, drift |
//! | [`engine`] | [`Engine`], [`VoiceParams`], the renderer, scores, WAV, samples, effects, the master bus |
//! | [`sched`] | [`Transport`], [`Clock`], windowed booking, statistics |
//! | [`signals`] | `sine()`, `saw2()`, `rand()`, and the rest of the reference's named signals |
//! | [`RenderOptions`], [`WavOptions`], [`Player`], [`PlayerOptions`] | The facade's own builders and handles |
//!
//! # Maths and features
//!
//! The default `libm` feature gives the same numbers on every target. Build with `--no-default-features` for
//! the platform's C library maths. The `serde` feature derives `Serialize` and `Deserialize` for
//! [`VoiceParams`] and its parts, with the TypeScript's field names.

pub mod error;
pub mod options;
pub mod player;
pub mod prelude;
pub mod rendering;
pub mod signals;

/// The pattern core: exact time, patterns, mini-notation, controls, signals, scales, and chords
/// ([`undertone_pattern`]).
pub use undertone_pattern as pattern;

/// The synth engine: voices on a graph, the renderer, scores, and WAV ([`undertone_engine`]).
pub use undertone_engine as engine;

/// The scheduler: windowed booking, a clock, and a transport ([`undertone_sched`]).
pub use undertone_sched as sched;

pub use error::{Error, ErrorKind, Result};
pub use options::{RenderOptions, WavOptions};
pub use player::{Player, PlayerOptions};
pub use prelude::*;
pub use rendering::{MAX_RENDER_SAMPLES, RenderedAudio, render, render_score, render_to_wav};
