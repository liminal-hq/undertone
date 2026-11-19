// Runs the layer 3 conformance corpus: voices and renders booked on a graph, compared with the recorded graph
//
// (c) Copyright 2026 Liminal HQ, Scott Morris
// SPDX-License-Identifier: MIT OR Apache-2.0

//! Layer 3 of the corpus: each case is a `score` (one voice per line, `v<k> @<seconds> <patch json>`) and the
//! `graph` the TypeScript reference recorded for it. Cases of a `voices` kind also carry an `output` setup, and
//! cases of a `render` kind a `program` and its `render` options.
//!
//! **The runner is group-agnostic**: it lists `conformance/cases/3/`, so a new group is picked up without a
//! change here. Each case is parsed into a [`Case`] and booked through [`book`].
//!
//! **What is pending.** The booking itself (RF-18, the pull request after the one that added this runner) does
//! not exist yet, so [`book`] returns [`Booked::NotImplemented`]. Groups whose cases cannot be booked yet are
//! named in [`PENDING`] with the reason. The test passes while a pending group is entirely pending and prints
//! what is pending; it fails if a pending group starts to book (so the entry is removed and the group is
//! compared), and it fails for any group that is not listed and does not equal the corpus.
//!
//! **How a booked graph is compared (CONFORMANCE.md).** Both sides are read as JSON; structure, strings, and
//! counts are exact, and a number inside a call string or a value matches when its text is identical or the
//! two differ by at most `1e-15` (the absolute floor for numerical zeros). Cases that pass only through the
//! floor are listed.
//!
//! Two further tests keep the writer honest without any booking: a graph built by hand through the [`Graph`]
//! trait for `placement-pan-default` must write the corpus bytes, and every recorded graph without buffers is
//! replayed through the trait and must write itself back byte for byte.

use serde_json::Value;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use undertone_engine::graph::{
	Automation, ChannelInterpretation, FilterType, Graph, GraphRecord, LogGraph, NodeId, NodeKind,
	OscillatorType, Oversample, ParamKind, Target,
};

/// Groups whose cases the booking cannot produce yet, with the reason. A group listed here must have every
/// case pending; a group not listed must be equal.
const PENDING: &[(&str, &str)] = &[(
	"placement",
	"voice booking lands in the next RF-18 pull request (this one adds the Graph trait and LogGraph)",
)];

/// The absolute floor for a number that should be zero.
const ABS_FLOOR: f64 = 1e-15;

/// One voice of a score.
#[derive(Debug)]
#[allow(dead_code)] // The fields are read by the booking, which is not here yet.
struct ScoreLine {
	name: String,
	at: f64,
	patch: Value,
}

/// One layer 3 case, with the parts the booking needs.
#[derive(Debug)]
#[allow(dead_code)] // The fields are read by the booking, which is not here yet.
struct Case {
	id: String,
	score: Vec<ScoreLine>,
	/// `output` of a voices case: the master bus and the channel count.
	output: Option<Value>,
	/// `program` and `render` of a render case.
	render: Option<(Value, Value)>,
	expected: Value,
}

/// What booking a case gave.
enum Booked {
	NotImplemented,
	#[allow(dead_code)] // Used once the booking exists.
	Graph(Box<GraphRecord>),
}

/// Books a case on a [`LogGraph`]. For now nothing is booked: the voice booking is the next pull request.
fn book(_case: &Case) -> Booked {
	Booked::NotImplemented
}

fn parse_score_line(line: &str) -> ScoreLine {
	let (name, rest) = line.split_once(" @").expect("a score line has a time");
	let (at, patch) = rest.split_once(' ').expect("a score line has a patch");
	ScoreLine {
		name: name.to_string(),
		at: at.parse().expect("the time is a number"),
		patch: serde_json::from_str(patch).expect("the patch is JSON"),
	}
}

fn parse_case(value: &Value) -> Case {
	let text = |key: &str| value[key].as_str().expect(key).to_string();
	Case {
		id: text("id"),
		score: value["score"]
			.as_array()
			.expect("score")
			.iter()
			.map(|line| parse_score_line(line.as_str().expect("a score line is text")))
			.collect(),
		output: value.get("output").cloned(),
		render: value
			.get("program")
			.map(|program| (program.clone(), value["render"].clone())),
		expected: value["graph"].clone(),
	}
}

fn corpus_dir() -> PathBuf {
	Path::new(env!("CARGO_MANIFEST_DIR")).join("../../conformance/cases/3")
}

/// Every group file of layer 3, by group name.
fn groups() -> BTreeMap<String, Vec<Value>> {
	let mut groups = BTreeMap::new();
	for entry in std::fs::read_dir(corpus_dir()).expect("conformance/cases/3 exists") {
		let path = entry.expect("a directory entry").path();
		if path.extension().is_none_or(|extension| extension != "json") {
			continue;
		}
		let text = std::fs::read_to_string(&path).expect("the corpus file reads");
		let file: Value = serde_json::from_str(&text).expect("the corpus file is JSON");
		assert_eq!(file["layer"], 3, "{} is a layer 3 file", path.display());
		let group = file["group"].as_str().expect("group").to_string();
		let cases = file["cases"].as_array().expect("cases").clone();
		groups.insert(group, cases);
	}
	groups
}

/// Whether two JSON values are equal: exactly, except that numbers in numeric tokens may differ by the floor.
/// Returns whether the floor was needed, or the path of the first difference.
fn compare(expected: &Value, actual: &Value, path: &str) -> Result<bool, String> {
	match (expected, actual) {
		(Value::Number(e), Value::Number(a)) => {
			let (e, a) = (e.as_f64().expect("f64"), a.as_f64().expect("f64"));
			if e == a {
				Ok(false)
			} else if (e - a).abs() <= ABS_FLOOR {
				Ok(true)
			} else {
				Err(format!("{path}: recorded {e}, rust {a}"))
			}
		}
		(Value::String(e), Value::String(a)) => {
			if e == a {
				return Ok(false);
			}
			let (e_tokens, a_tokens): (Vec<_>, Vec<_>) =
				(e.split(' ').collect(), a.split(' ').collect());
			if e_tokens.len() != a_tokens.len() {
				return Err(format!("{path}: recorded {e:?}, rust {a:?}"));
			}
			let mut floor = false;
			for (x, y) in e_tokens.iter().zip(&a_tokens) {
				if x == y {
					continue;
				}
				let (x, y) = (
					x.trim_start_matches('@').parse::<f64>(),
					y.trim_start_matches('@').parse::<f64>(),
				);
				match (x, y) {
					(Ok(x), Ok(y)) if (x - y).abs() <= ABS_FLOOR => floor = true,
					_ => return Err(format!("{path}: recorded {e:?}, rust {a:?}")),
				}
			}
			Ok(floor)
		}
		(Value::Array(e), Value::Array(a)) => {
			if e.len() != a.len() {
				return Err(format!(
					"{path}: {} recorded, {} from rust",
					e.len(),
					a.len()
				));
			}
			let mut floor = false;
			for (index, (x, y)) in e.iter().zip(a).enumerate() {
				floor |= compare(x, y, &format!("{path}[{index}]"))?;
			}
			Ok(floor)
		}
		(Value::Object(e), Value::Object(a)) => {
			let keys = |object: &serde_json::Map<String, Value>| {
				object.keys().cloned().collect::<Vec<_>>()
			};
			if keys(e) != keys(a) {
				return Err(format!(
					"{path}: keys {:?} recorded, {:?} from rust",
					keys(e),
					keys(a)
				));
			}
			let mut floor = false;
			for (key, x) in e {
				floor |= compare(x, &a[key], &format!("{path}.{key}"))?;
			}
			Ok(floor)
		}
		(e, a) if e == a => Ok(false),
		(e, a) => Err(format!("{path}: recorded {e}, rust {a}")),
	}
}

#[test]
fn layer_3_cases_are_equal_or_listed_as_pending() {
	let groups = groups();
	assert!(!groups.is_empty(), "no layer 3 group was found");
	for (listed, _) in PENDING {
		assert!(
			groups.contains_key(*listed),
			"PENDING names a missing group {listed}"
		);
	}
	let mut failures = Vec::new();
	for (group, cases) in &groups {
		let pending_reason = PENDING
			.iter()
			.find(|(name, _)| name == group)
			.map(|(_, r)| *r);
		let (mut equal, mut pending, mut floor_ids) = (0usize, 0usize, Vec::new());
		for value in cases {
			let case = parse_case(value);
			match book(&case) {
				Booked::NotImplemented => pending += 1,
				Booked::Graph(record) => {
					let actual: Value = serde_json::from_str(&record.to_json(""))
						.expect("the writer produces JSON");
					match compare(&case.expected, &actual, &case.id) {
						Ok(floor) => {
							equal += 1;
							if floor {
								floor_ids.push(case.id.clone());
							}
						}
						Err(difference) => failures.push(difference),
					}
				}
			}
		}
		let total = cases.len();
		println!("layer 3 {group}: {equal}/{total} equal, {pending} pending");
		if !floor_ids.is_empty() {
			println!("  equal only within the absolute floor: {floor_ids:?}");
		}
		match pending_reason {
			Some(reason) => {
				println!("  pending: {reason}");
				if pending != total {
					failures.push(format!(
						"{group}: listed as pending but {} of {total} cases book; remove it from PENDING",
						total - pending
					));
				}
			}
			None if pending > 0 => {
				failures.push(format!(
					"{group}: {pending} of {total} cases are not implemented and the group is not in PENDING"
				));
			}
			None => {}
		}
	}
	assert!(
		failures.is_empty(),
		"layer 3 differences:\n{}",
		failures.join("\n")
	);
}

/// The text of the `graph` object of a case in a corpus file, as the file holds it (the lines from
/// `"graph": {` to its closing brace, with the brace's own line indentation kept).
fn graph_text_in_file(group: &str, id: &str) -> String {
	let text = std::fs::read_to_string(corpus_dir().join(format!("{group}.json"))).expect("file");
	let start = text
		.find(&format!("\"id\": \"{id}\""))
		.unwrap_or_else(|| panic!("case {id} is in the file"));
	let after = &text[start..];
	let key = after.find("\"graph\": ").expect("the case has a graph") + "\"graph\": ".len();
	let object = &after[key..];
	// The graph is the last key of a case: its closing brace is the first line that is exactly six spaces and `}`.
	let end = object.find("\n      }").expect("the graph ends") + "\n      }".len();
	object[..end].to_string()
}

/// `placement-pan-default` built by hand: a triangle voice at 220 Hz through a gain envelope and a panner.
#[test]
fn a_hand_built_graph_writes_the_corpus_bytes() {
	let mut graph = LogGraph::new(44_100.0, 2);
	let gain = graph.create_node(NodeKind::Gain);
	let oscillator = graph.create_node(NodeKind::Oscillator);
	let panner = graph.create_node(NodeKind::StereoPanner);
	let level = graph.param(gain, ParamKind::Gain);
	graph.set_oscillator_type(oscillator, OscillatorType::Triangle);
	let frequency = graph.param(oscillator, ParamKind::Frequency);
	graph.set_value_at_time(frequency, 220.0, 0.0);
	graph.set_value_at_time(level, 0.0, 0.0);
	graph.linear_ramp_to_value_at_time(level, 0.3, 0.01);
	graph.linear_ramp_to_value_at_time(level, 0.15, 0.11);
	graph.set_value_at_time(level, 0.15, 0.5);
	graph.linear_ramp_to_value_at_time(level, 0.0, 0.7);
	let pan = graph.param(panner, ParamKind::Pan);
	graph.set_value_at_time(pan, 0.5, 0.0);
	graph.connect_node(oscillator, gain);
	graph.connect_node(gain, panner);
	graph.connect_node(panner, graph.destination());
	graph.start(oscillator, 0.0);
	graph.stop(oscillator, 0.72);

	let written = graph.finish(None).to_json("      ");
	assert_eq!(
		written,
		graph_text_in_file("placement", "placement-pan-default")
	);
}

/// Parses one call string of a parameter, as `LogGraph` writes it.
fn parse_call(call: &str) -> Automation {
	let tokens: Vec<&str> = call.split(' ').collect();
	let number = |text: &str| -> f64 { text.trim_start_matches('@').parse().expect("a number") };
	match tokens[0] {
		"set" => Automation::Set {
			value: number(tokens[1]),
			time: number(tokens[2]),
		},
		"lin" => Automation::LinearRamp {
			value: number(tokens[1]),
			time: number(tokens[2]),
		},
		"exp" => Automation::ExponentialRamp {
			value: number(tokens[1]),
			time: number(tokens[2]),
		},
		"target" => Automation::Target {
			value: number(tokens[1]),
			time: number(tokens[2]),
			time_constant: number(tokens[4]),
		},
		"cancel" => Automation::Cancel {
			time: number(tokens[1]),
		},
		other => panic!("unknown call {other}"),
	}
}

fn node_kind(name: &str) -> Option<NodeKind> {
	Some(match name {
		"oscillator" => NodeKind::Oscillator,
		"gain" => NodeKind::Gain,
		"filter" => NodeKind::BiquadFilter,
		"panner" => NodeKind::StereoPanner,
		"merger" => NodeKind::ChannelMerger { inputs: 2 },
		"bufferSource" => NodeKind::BufferSource,
		"convolver" => NodeKind::Convolver,
		"delay" => NodeKind::Delay,
		"compressor" => NodeKind::DynamicsCompressor,
		"waveShaper" => NodeKind::WaveShaper,
		_ => return None,
	})
}

fn param_kind(name: &str) -> ParamKind {
	[
		ParamKind::Frequency,
		ParamKind::Gain,
		ParamKind::Q,
		ParamKind::Pan,
		ParamKind::DelayTime,
		ParamKind::Threshold,
		ParamKind::Knee,
		ParamKind::Ratio,
		ParamKind::Attack,
		ParamKind::Release,
		ParamKind::PlaybackRate,
	]
	.into_iter()
	.find(|kind| kind.name() == name)
	.unwrap_or_else(|| panic!("unknown parameter {name}"))
}

fn f32s(values: &Value) -> Vec<f32> {
	values
		.as_array()
		.expect("an array")
		.iter()
		.map(|v| match v.get("$num").and_then(Value::as_str) {
			Some("-0") => -0.0,
			Some(other) => panic!("special number {other}"),
			None => v.as_f64().expect("number") as f32,
		})
		.collect()
}

/// Replays a recorded graph without buffers through the `Graph` trait. Returns `None` for a graph with buffers
/// (their samples are not in the corpus, only their summaries).
fn replay(graph: &Value) -> Option<LogGraph> {
	if !graph["buffers"].as_array().expect("buffers").is_empty() {
		return None;
	}
	let mut log = LogGraph::new(
		graph["sampleRate"].as_f64().expect("rate"),
		graph["channels"].as_u64().expect("channels") as u32,
	);
	let nodes = graph["nodes"].as_array().expect("nodes");
	let waves: Vec<_> = graph["waves"]
		.as_array()
		.expect("waves")
		.iter()
		.map(|wave| {
			log.create_periodic_wave(
				&f32s(&wave["real"]),
				&f32s(&wave["imag"]),
				wave["disableNormalization"].as_bool().expect("flag"),
			)
		})
		.collect();
	let ids: Vec<NodeId> = nodes
		.iter()
		.map(
			|node| match node_kind(node["kind"].as_str().expect("kind")) {
				Some(kind) => log.create_node(kind),
				None => log.destination(),
			},
		)
		.collect();
	for (index, node) in nodes.iter().enumerate() {
		let id = ids[index];
		if let Some(fields) = node.get("fields") {
			for (key, value) in fields.as_object().expect("fields") {
				match (key.as_str(), value) {
					("type", Value::String(text)) if text == "custom" => {}
					("type", Value::String(text)) => match node["kind"].as_str().expect("kind") {
						"oscillator" => log.set_oscillator_type(
							id,
							match text.as_str() {
								"square" => OscillatorType::Square,
								"sawtooth" => OscillatorType::Sawtooth,
								"triangle" => OscillatorType::Triangle,
								_ => OscillatorType::Sine,
							},
						),
						_ => log.set_filter_type(
							id,
							match text.as_str() {
								"highpass" => FilterType::Highpass,
								"allpass" => FilterType::Allpass,
								other => panic!("filter type {other}"),
							},
						),
					},
					("wave", Value::String(text)) => {
						let number: usize = text[1..].parse().expect("a wave number");
						log.set_periodic_wave(id, waves[number]);
					}
					("loop", Value::Bool(flag)) => log.set_loop(id, *flag),
					("oversample", Value::String(text)) => log.set_oversample(
						id,
						if text == "2x" {
							Oversample::X2
						} else {
							Oversample::X4
						},
					),
					("channelCount", number) => {
						log.set_channel_count(id, number.as_u64().expect("count") as u32);
					}
					("channelInterpretation", Value::String(text)) => log
						.set_channel_interpretation(
							id,
							if text == "discrete" {
								ChannelInterpretation::Discrete
							} else {
								ChannelInterpretation::Speakers
							},
						),
					other => panic!("a field the replay does not know: {other:?}"),
				}
			}
		}
		if let Some(params) = node.get("params") {
			for (key, calls) in params.as_object().expect("params") {
				let param = log.param(id, param_kind(key));
				for call in calls.as_array().expect("calls") {
					log.automate(param, parse_call(call.as_str().expect("call text")));
				}
			}
		}
		for (key, method) in [("start", true), ("stop", false)] {
			if let Some(times) = node.get(key) {
				for time in times.as_array().expect("times") {
					let time = time.as_f64().expect("time");
					if method {
						log.start(id, time)
					} else {
						log.stop(id, time)
					}
				}
			}
		}
		for _ in 0..node.get("disconnects").and_then(Value::as_u64).unwrap_or(0) {
			log.disconnect(id);
		}
	}
	// Connections last, because a connection may point at a node made after its source.
	for (index, node) in nodes.iter().enumerate() {
		for target in node
			.get("to")
			.and_then(Value::as_array)
			.into_iter()
			.flatten()
		{
			let text = target.as_str().expect("target text");
			let (name, ports) = text
				.split_once(' ')
				.map_or((text, None), |(n, p)| (n, Some(p)));
			let (output, input) = ports.map_or((0, 0), |p| {
				let words: Vec<&str> = p.split(' ').collect();
				(
					words[1].parse().expect("output"),
					words[3].parse().expect("input"),
				)
			});
			let (node_text, param) = name
				.split_once('.')
				.map_or((name, None), |(n, p)| (n, Some(p)));
			let target_node = ids[node_text[1..].parse::<usize>().expect("a node number")];
			let target = match param {
				Some(param) => Target::Param(log.param(target_node, param_kind(param))),
				None => Target::Node(target_node),
			};
			log.connect(ids[index], target, output, input);
		}
	}
	Some(log)
}

/// Every recorded graph without buffers, replayed through the trait, writes itself back byte for byte.
#[test]
fn recorded_graphs_without_buffers_replay_to_the_same_bytes() {
	let (mut replayed, mut skipped) = (0usize, 0usize);
	for (group, cases) in groups() {
		for case in &cases {
			let id = case["id"].as_str().expect("id");
			let Some(log) = replay(&case["graph"]) else {
				skipped += 1;
				continue;
			};
			let length = case["graph"]["length"].as_u64();
			assert_eq!(
				log.finish(length).to_json("      "),
				graph_text_in_file(&group, id),
				"{id}"
			);
			replayed += 1;
		}
	}
	println!("replayed {replayed} recorded graphs; {skipped} skipped because they hold buffers");
	assert!(replayed > 0);
}
