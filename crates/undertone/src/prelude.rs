// The prelude: the names a user needs for every topic of the guide
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

//! The names most programs need, in one glob import: `use undertone::prelude::*;`.
//!
//! The prelude is the flat, curated surface of the crate. Everything in it is also reachable by its full path
//! (`undertone::pattern::...`, `undertone::engine::...`, `undertone::sched::...`), and the crates' less common
//! items live only there. [`Result`](crate::Result) is deliberately left out so the glob import does not shadow
//! `std`'s own: write `undertone::Result<T>`.
//!
//! Where two crates use one name, the prelude takes the one a program is likelier to want and the other stays
//! under its path: [`PlayOptions`] is the scheduler's (the engine's is `undertone::engine::score::PlayOptions`,
//! for `Score::play`), and [`Pitch`] is the engine's `VoiceParams` pitch (the pattern crate's borrowed one is
//! `undertone::pattern::pitch::Pitch`).
//!
//! By topic:
//!
//! | Topic | Names |
//! | --- | --- |
//! | Time and patterns | [`Fraction`], [`Span`], [`Hap`], [`Pattern`], [`Value`], [`mini`], [`pure`], [`silence`], [`stack`], [`seq`], [`cat`], [`timecat`], [`arrange`], [`fast`], [`slow`], [`rev`] |
//! | Notes and sounds | [`note`], [`note_hz`], [`sound`], [`s`], [`n`], [`n_degree`], [`n_pattern`], [`note_to_midi`], [`note_to_frequency`], [`midi_to_frequency`] |
//! | Controls | [`Control`], [`ControlInput`], [`CONTROLS`], and the methods on [`Pattern`] |
//! | Harmony | [`chord`], [`VoicingOptions`], [`Anchor`] |
//! | Signals | [`sine`], [`saw`], [`rand`], [`perlin`], [`signal`], and the rest of [`signals`](crate::signals) |
//! | Randomness | [`Seed`], [`seeded_random`], [`drift`], [`DriftOptions`] |
//! | Instruments and scores | [`fm_voice`], [`fm_presets`], [`FmPresets`], [`SHAPED_WAVE_TYPES`], [`is_shaped_wave`], [`FmVoiceDefinition`], [`EnvelopeDefinition`], [`layer`], [`LayerOptions`], [`Score`], [`ScoreDefinition`], [`ScoreEvent`], [`ScoreNote`], [`ScorePanPoint`], [`ScoreAutopan`], [`Seam`] |
//! | Rendering and files | [`render`], [`render_score`], [`render_to_wav`], [`RenderOptions`], [`RenderedAudio`], [`WavOptions`], [`BitDepth`], [`encode_wav`], [`MasterSetting`], [`MasterBusOptions`], [`Limiter`], [`LimiterOptions`] |
//! | Playing | [`Player`], [`PlayerOptions`], [`PlayOptions`], [`LoopOptions`], [`LoopStop`], [`LoopVoices`], [`LoopHandle`], [`PlaybackHandle`], [`TickReport`], [`Stats`] |
//! | Hosts | [`Engine`], [`OutputSetup`], [`Graph`], [`LogGraph`], [`RenderGraph`], [`Transport`], [`Clock`], [`ManualClock`], [`SchedulerOptions`], [`Tempo`] |
//! | Samples | [`Samples`], [`SampleData`], [`SampleSource`], [`Pitch`] |
//! | Placement | [`CHANNEL_ORDER`], [`MAX_CHANNELS`], [`surround_gains`], [`fold_to_stereo`], [`enable_multichannel`], [`create_mono_fold`], [`PanPoint`] |
//! | Effects | [`OrbitBus`], [`build_impulse_response`], and `Engine::orbit_bus` |
//! | Resolved voices | [`VoiceParams`], [`resolve_params`] |
//! | Errors | [`Error`], [`ErrorKind`] |

pub use crate::error::{Error, ErrorKind};
pub use crate::options::{RenderOptions, WavOptions};
pub use crate::player::{Player, PlayerOptions};
pub use crate::render::{RenderedAudio, render, render_score, render_to_wav};
pub use crate::signals::{
	brand, brand_by, choose, cosine, cosine2, irand, isaw, isaw2, perlin, rand, rand2, saw, saw2,
	signal, sine, sine2, square, square2, tri, tri2,
};

pub use undertone_pattern::chord::{Anchor, VoicingOptions, chord};
pub use undertone_pattern::control::{n, n_degree, n_pattern, note, note_hz, s, sound};
pub use undertone_pattern::drift::{DriftOptions, drift};
pub use undertone_pattern::instruments::{
	EnvelopeDefinition, FmPresets, FmVoiceDefinition, LayerOptions, fm_presets, fm_voice, layer,
};
pub use undertone_pattern::pitch::{midi_to_frequency, note_to_frequency, note_to_midi};
pub use undertone_pattern::random::{Seed, seeded_random};
pub use undertone_pattern::{
	CONTROLS, Control, ControlInput, ControlMap, Fraction, Hap, Pattern, Span, Value, arrange, cat,
	fast, mini, pure, rev, seq, silence, slow, stack, timecat,
};

pub use undertone_engine::effects::{OrbitBus, build_impulse_response};
pub use undertone_engine::engine::{Engine, OutputSetup, Playback};
pub use undertone_engine::graph::{Graph, LogGraph};
pub use undertone_engine::master::{Limiter, LimiterOptions, MasterBusOptions};
pub use undertone_engine::params::{PanPoint, Pitch, SoundType, VoiceParams, resolve_params};
pub use undertone_engine::render::MasterSetting;
pub use undertone_engine::render_graph::RenderGraph;
pub use undertone_engine::samples::{SampleData, SampleSource, Samples};
pub use undertone_engine::score::{
	Score, ScoreAutopan, ScoreDefinition, ScoreEvent, ScoreNote, ScorePanPoint, Seam,
};
pub use undertone_engine::surround::{
	CHANNEL_ORDER, MAX_CHANNELS, create_mono_fold, enable_multichannel, fold_to_stereo,
	surround_gains,
};
pub use undertone_engine::wav::{BitDepth, encode_wav};
pub use undertone_engine::waves::{SHAPED_WAVE_TYPES, is_shaped_wave};

pub use undertone_sched::{
	Clock, LoopHandle, LoopOptions, LoopStop, LoopVoices, ManualClock, PlayOptions, PlaybackHandle,
	SchedulerOptions, Stats, Tempo, TickReport, Transport,
};
