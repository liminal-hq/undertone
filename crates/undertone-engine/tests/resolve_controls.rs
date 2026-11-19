// Resolves every control of the controls table to VoiceParams and checks the fields it writes
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

//! The corpus exercises a handful of controls. This test applies **every** row of
//! [`undertone_pattern::CONTROLS`], resolves the event, and checks that each field the row says it writes is
//! present in the resolved parameters under its JSON name, with the value that was given. So the table's field
//! names, the control methods, and `resolve_params` cannot disagree, and a control that the corpus never uses
//! still has a check.

use serde_json::{Value as Json, json};
use undertone_engine::params::{SoundType, VoiceParams, resolve_params};
use undertone_pattern::control::note;
use undertone_pattern::{CONTROLS, Fraction, Pattern, Span, Value};

fn first_voice(pattern: &Pattern<Value>) -> VoiceParams {
	let haps = pattern.query(Span::new(Fraction::from_int(0), Fraction::from_int(1)));
	resolve_params(&haps[0].value)
}

/// A JSON value with every number as a float, as the resolved objects hold them (`json!(0)` is an integer).
fn floats(value: Json) -> Json {
	match value {
		Json::Number(n) => json!(n.as_f64().expect("a finite number")),
		Json::Array(items) => Json::Array(items.into_iter().map(floats).collect()),
		Json::Object(map) => Json::Object(map.into_iter().map(|(k, v)| (k, floats(v))).collect()),
		other => other,
	}
}

fn as_json(params: &VoiceParams) -> Json {
	serde_json::to_value(params).expect("serialises")
}

/// The pattern with the control `name` applied with a valid value, and the JSON the table's fields should hold.
fn apply(name: &str) -> (Pattern<Value>, Vec<(&'static str, Json)>) {
	let base = note("c3").unwrap();
	let spec = CONTROLS.iter().find(|c| c.js_name == name).unwrap();
	let field = spec.fields[0];
	if spec.is_patternable() && name != "panslide" {
		let given = if name == "early" { -0.5 } else { 0.5 };
		let method: Pattern<Value> = base
			.control(undertone_pattern::Control::from_name(name).unwrap(), 0.5)
			.unwrap();
		return (method, vec![(field, json!(given))]);
	}
	match name {
		"panslide" => (
			base.pan_slide(0.5, Some(0.2)).unwrap(),
			vec![("panSlideFrom", json!(0.5)), ("panSlideTime", json!(0.2))],
		),
		"fmenv" => (
			base.fm_env("lin").unwrap(),
			vec![("fmEnvCurve", json!("lin"))],
		),
		"fmwave" => (
			base.fm_wave("square").unwrap(),
			vec![("fmWave", json!("square"))],
		),
		"autopanshape" => (
			base.autopan_shape("triangle").unwrap(),
			vec![("autopanShape", json!("triangle"))],
		),
		"pitchsteps" => (
			base.pitch_steps(&[0.0, 7.0], Some(50.0)).unwrap(),
			vec![
				("pitchSteps", json!([0.0, 7.0])),
				("pitchStepRate", json!(50.0)),
			],
		),
		"cut" => (base.cut(2.0).unwrap(), vec![("cutGroup", json!(2.0))]),
		"panpath" => (
			base.pan_path(&[-1.0, 1.0], Some(2.0)).unwrap(),
			vec![(
				"panPath",
				json!([{"pan": -1.0, "time": 0.0}, {"pan": -1.0, "time": 0.5}, {"pan": 1.0, "time": 0.5}]),
			)],
		),
		"panlaw" => (base.pan_law(-6.0).unwrap(), vec![("panLaw", json!(-6.0))]),
		"orbit" => (base.orbit(1.0).unwrap(), vec![("orbit", json!(1.0))]),
		"channels" => (
			base.channels(&[1.0, 0.5]).unwrap(),
			vec![("channelGains", json!([1.0, 0.5]))],
		),
		"surround" => (
			base.surround(0.0).unwrap(),
			vec![(
				"channelGains",
				json!([0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 0.0]),
			)],
		),
		"sound" => (base.sound("white"), vec![("soundType", json!("white"))]),
		"s" => (base.s("bd"), vec![("sampleName", json!("bd"))]),
		"bank" => (
			base.bank("RolandTR909"),
			vec![("sampleBank", json!("RolandTR909"))],
		),
		other => panic!("no example for {other}"),
	}
}

#[test]
fn every_control_in_the_table_resolves_into_the_fields_it_names() {
	for spec in CONTROLS {
		let (pattern, expected) = apply(spec.js_name);
		let json = as_json(&first_voice(&pattern));
		for (field, value) in &expected {
			assert_eq!(
				&json[*field], value,
				"{}: field {field} in {json}",
				spec.js_name
			);
		}
		// Every field the row lists is checked, except the one `sound` and `s` clear on purpose.
		for field in spec.fields {
			let listed = expected.iter().any(|(f, _)| f == field);
			assert!(
				listed || matches!(spec.js_name, "s" | "sound"),
				"{}: the table lists {field}, which the example does not check",
				spec.js_name
			);
		}
	}
}

#[test]
fn a_sample_voice_has_no_sound_type_and_holds() {
	let sample = first_voice(&note("c3").unwrap().s("bd"));
	assert_eq!(sample.sound_type, None);
	assert_eq!(sample.sample_name.as_deref(), Some("bd"));
	assert_eq!(sample.sustain, 1.0, "the sample rule");
	let explicit = first_voice(&note("c3").unwrap().s("bd").sustain(0.25).unwrap());
	assert_eq!(explicit.sustain, 0.25);
	// Going back to a synth type clears the sample again.
	let back = first_voice(&note("c3").unwrap().s("bd").sound("square"));
	assert_eq!(back.sound_type, Some(SoundType::Square));
	assert_eq!(back.sample_name, None);
	assert_eq!(back.sustain, 0.0);
}

#[test]
fn the_eight_pan_fields_of_0_4_0_resolve_together() {
	let p = note("c3")
		.unwrap()
		.pan_path_points(&[(0.0, -1.0), (0.25, 1.0)])
		.unwrap()
		.autopan(2.0)
		.unwrap()
		.autopan_depth(0.5)
		.unwrap()
		.autopan_shape("square")
		.unwrap()
		.autopan_phase(0.25)
		.unwrap()
		.pan_slide(-1.0, Some(0.1))
		.unwrap()
		.pan_law(-6.0)
		.unwrap();
	let json = as_json(&first_voice(&p));
	for (field, value) in [
		(
			"panPath",
			json!([{"pan": -1.0, "time": 0.0}, {"pan": 1.0, "time": 0.25}]),
		),
		("autopan", json!(2.0)),
		("autopanDepth", json!(0.5)),
		("autopanShape", json!("square")),
		("autopanPhase", json!(0.25)),
		("panSlideFrom", json!(-1.0)),
		("panSlideTime", json!(0.1)),
		("panLaw", json!(-6.0)),
	] {
		assert_eq!(json[field], value, "{field}");
	}
}

#[test]
fn a_controlless_event_resolves_to_the_defaults() {
	assert_eq!(
		resolve_params(&Value::Map(Default::default())),
		VoiceParams::empty()
	);
	assert_eq!(resolve_params(&Value::Num(1.0)), VoiceParams::empty());
	// `degree` and `chord` are not parameters.
	let unresolved = Value::field("degree", Value::Num(3.0));
	assert_eq!(resolve_params(&unresolved), VoiceParams::empty());
}

#[test]
fn a_patch_replaces_defaults_even_with_a_zero() {
	let p = first_voice(&note("c3").unwrap().gain(0.0).unwrap().attack(0.0).unwrap());
	assert_eq!((p.gain_level, p.attack), (0.0, 0.0));
}

/// Values recorded by running the TypeScript reference (`resolveParams` over `src/pattern.ts` at the reference
/// commit, with `bun`) on controls the corpus does not use: the whole resolved object of a chain of controls, and
/// the stepped pan path and pitch steps.
#[test]
fn controls_the_corpus_does_not_use_match_the_reference() {
	let p = note("c3")
		.unwrap()
		.fmi(2.0)
		.unwrap()
		.fmh(1.5)
		.unwrap()
		.fm_env("lin")
		.unwrap()
		.fm_wave("halfsine")
		.unwrap()
		.velocity(0.3)
		.unwrap()
		.legato("0.5")
		.unwrap()
		.duration(1.2)
		.unwrap()
		.pdecay("0.2")
		.unwrap();
	let recorded = json!({
		"soundType": "sine", "pitch": "c3", "gainLevel": 0.8, "attack": 0.01, "decay": 0.1, "sustain": 0,
		"release": 0.05, "filterEnvAmount": 0, "filterAttack": 0, "filterDecay": 0, "filterSustain": 1,
		"filterRelease": 0, "roomSize": 3, "delayTime": 0.3, "delayFeedback": 0.35, "slideTime": 0,
		"nudgeTime": 0, "fmIndex": 2, "fmHarmonicity": 1.5, "fmEnvCurve": "lin", "fmWave": "halfsine",
		"velocity": 0.3, "legato": 0.5, "duration": 1.2, "pitchDecay": 0.2
	});
	assert_eq!(as_json(&first_voice(&p)), floats(recorded));
	let path = note("c3")
		.unwrap()
		.pan_path(&[-1.0, -1.0, 1.0, 0.5], Some(2.0))
		.unwrap();
	assert_eq!(
		as_json(&first_voice(&path))["panPath"],
		floats(json!([
			{"time": 0, "pan": -1}, {"time": 1, "pan": -1}, {"time": 1, "pan": 1},
			{"time": 1.5, "pan": 1}, {"time": 1.5, "pan": 0.5}
		]))
	);
	let steps = note("c3")
		.unwrap()
		.pitch_steps(&[0.0, 7.0], Some(100.0))
		.unwrap();
	let json = as_json(&first_voice(&steps));
	assert_eq!(
		(&json["pitchSteps"], &json["pitchStepRate"]),
		(&floats(json!([0, 7])), &floats(json!(100)))
	);
}
