# Measuring false activations for an assistive switch

**Status: a protocol, not a study.** Nobody has run this yet. It exists because
the number it produces does not exist in the literature, and a documented method
is the cheapest way to make it exist.

---

## 1. The gap, stated precisely

**There is no standardised per-hour or per-session false-activation benchmark for
assistive switch access.** Not for single switches, not for sip-and-puff, not for
EMG switches, not for head pointers, not for eye gaze. There is also no
cross-method comparable rate.

Say it that precisely, because the looser version is false. Per-**trial**
false-positive measurement *is* established and reusable:

| What exists | What does not exist |
|---|---|
| **SITbench 1.0** (Esiyok & Albayrak, *J Healthcare Engineering* 2019:5075163, PMC6721442) computes accuracy, precision, recall and FPR = FP/(FP+TN) automatically per trial, across three switch-operated games | Any per-hour or per-session rate |
| Per-study per-trial error rates (Fager 2022; the Nomon study, ASSETS 2023) | Any cross-method comparable rate |
| **Koester's scanning rule of thumb**: revise when scan errors exceed **25% of correct selections** | A rate over time — Koester's is a ratio |
| Throughput metrics: characters/minute, words/minute | An error rate normalised by duration |

**Two facts that make the gap a gap rather than an impossibility:**

- Per-hour false-positive rates *are* conventional in adjacent fields — fall
  sensors ("0.025 false alarms/hour"), intrusion detection, bioacoustic
  detection. So the absent metric is absent by omission, not by being
  inapplicable.
- The field has named the problem and left it open. Eddy et al. (CHI '23,
  "A Framework and Call to Action for the Future Development of EMG-Based Input
  in HCI") list **false activation** as one of five unresolved categories, and
  their 2025 follow-up opens by stating that current myoelectric control methods
  "are prone to false activations under real-world conditions."

**The strongest single piece of evidence:** SITbench was published in 2019 and
has been cited **3 times**. A benchmark that nobody adopts is not a standard, and
its metrics — however well specified — have not become the field's.

### A naming trap, recorded so it is not repeated

**SITbench** is the benchmark with the accuracy/precision/recall/FPR metrics.
**SAM** is the **Switch Access Measure** (Nguyen, Tilbrook, Sandelance, Wright;
*Disability and Rehabilitation: Assistive Technology* 2023;18(5):673-684) — a
16-item video-rated functional assessment for children with severe and multiple
disabilities, with inter-rater ICC 0.82. It does not define accuracy, precision,
recall, or FPR. These are two unrelated instruments, and conflating them is an
easy error because "SAM" reads like "single access method."

Two further same-name collisions to avoid when searching: **SWITCH** (BAAI
Agents, embodied-agent benchmark) and **SiT-Bench** (LLM spatial intelligence).
Neither is about switch access.

### What the 2025 EMG evidence actually says

Judge et al. 2025 (*Disability and Rehabilitation: Assistive Technology*,
DOI 10.1080/17483107.2025.2501746) tested a dry-sensor EMG switch and found
**more false-positive activations than the comparison condition**, with
participants describing this as affecting usability. It is a directional,
comparative finding. **It reports no per-hour rate.** That is the gap in
miniature: a study that identifies false activation as the usability problem,
without a unit to express how big the problem is.

An adjacent finding worth carrying into any design review: participants
generally **prefer false negatives to false positives** (Lafreniere, Jonker et
al., "False Positives vs. False Negatives," UIST 2021). False positives impose
greater attentional demand, and recovering from one carries a task-switching
cost. This is why `ActivationDetector` raises its onset multiplier to 3σ rather
than the conventional 2σ.

---

## 2. What this protocol measures

Four quantities, each with the unit it needs:

| Metric | Definition | Unit |
|---|---|---|
| **False activations** | Detector fired; user did not intend it | count / hour |
| **Missed activations** | User intended it; detector did not fire | count / hour |
| **Activation latency** | Onset of intent → activation | ms, median + IQR |
| **Selection success** | Target reached without undo, per attempt | ratio |

The first is the one that does not exist anywhere. The other three are
conventional and are included because a false-activation count is uninterpretable
without them — a detector that never misfires because it never fires is not a
good detector.

**A per-hour rate needs a denominator you can defend.** "Per hour of use" is
ambiguous: an hour of continuous selection work and an hour of watching a video
with the switch armed are different exposures. So record **both**:

- **per hour of armed time** — the switch was active and could fire
- **per hour of active-use time** — the user was working at selection

Report both. A design that misfires during video playback has a different defect
from one that misfires during selection, and one number hides that.

---

## 3. The procedure

### 3.1 Instrumentation

`ActivationDetector` and `DwellEngine` already expose what this needs. Nothing
new is required to *log*; the protocol is about how to *run* it and how to
report it.

Log one record per event, with a monotonic timestamp. The callbacks below are
the real signatures — `onPress` is `(tMs, level)`, `onActivate` is
`(id, meta)`, `onCancel` is `(id, meta)`:

```js
const log = [];              // one array per session
const t0 = performance.now();

// Detector-side (analog sources: EMG, sip-and-puff)
new ActivationDetector({
  onPress: (tMs, level) => log.push({ t: tMs - t0, type: 'press', level }),
  onRelease: (tMs) => log.push({ t: tMs - t0, type: 'release' }),
});

// Dwell-side (gaze, pointer, switch scanning)
new DwellEngine({
  onActivate: (id, meta) => log.push({ t: meta.tMs - t0, type: 'activate', id, dwellMs: meta.dwellMs }),
  onCancel: (id, meta) => log.push({ t: performance.now() - t0, type: 'cancel', id, reason: meta.reason }),
});

// Ground truth, marked by a person or an observer
function mark(label) { log.push({ t: performance.now() - t0, type: 'label', label }); }
```

`onCancel`'s `meta` carries `{ reason, progress }` and no timestamp, so it is
stamped at call time above — the reason still distinguishes the cases a
measurement cares about (`'paused'`, `'clock-gap'`, `'left'`, `'replaced'`).

**The labels are the measurement.** Everything else is a machine record of what
the detector did; the labels are the record of what the user meant. Without them
there is no way to distinguish a false activation from a real one, and a suite of
tests asserting internal consistency cannot substitute — an engine can be
perfectly self-consistent and still misfire on a person.

### 3.2 Conditions

Run at least these, because false-activation rate is not a single number — it is
a function of what the user is doing:

| Condition | Duration | Purpose |
|---|---|---|
| **Targeted selection** | 10 min | The intended-use case. Produces latency and success rate. |
| **Idle, switch armed** | 10 min | Non-use with the device live. Isolates signal-noise misfires. |
| **Distraction / conversation** | 5 min | The classic false-activation generator for EMG. Facial and postural movement unrelated to intent. |
| **Fatigue repeat** | repeat the first condition | The same work after 30 minutes. Signal characteristics drift with fatigue, and a detector tuned on a fresh arm is not tuned on a tired one. |

The fatigue repeat is not optional if the number is going to be quoted. A rate
measured only while fresh is the best case presented as the case.

### 3.3 Labelling

Whoever marks ground truth should know the intended targets in advance —
a predetermined sequence of selections, not free exploration. Free exploration
makes intent unrecoverable after the fact, which is how a false-activation study
degrades into opinion.

- **Intended activation** — user selects the announced target within the window.
- **False activation** — detector fires with no target announced, or fires on the
  wrong target.
- **Missed activation** — the window closes with the target unselected.
- **Ambiguous** — record it and count it separately. Do not fold ambiguity into
  either category; a protocol that forces every event into pass/fail manufactures
  precision it does not have.

### 3.4 Reporting

Report per condition, with the denominator named:

```
Condition: idle, switch armed · 10 min · dry-sensor EMG, forearm
  False activations:  7  →  42 / hour armed
  Missed:             0  →  n/a (no targets)
  Ambiguous:          2  (reported, not counted)

Condition: targeted selection · 10 min · same
  Activations:       84 intended, 3 false, 5 missed
  False rate:        3 / 0.167 h  →  18 / hour active-use
  Latency:           median 218 ms, IQR 154–301
  Success:           76/84 attempts = 0.90
```

**Never report a single aggregate rate.** The two conditions above differ by a
factor of two, and collapsing them produces a number that predicts neither.

---

## 4. What this protocol cannot do

**It cannot make the result generalisable.** This measures one person, on one
device, one day. That is deliberately the smallest useful unit: it is enough to
answer "is this configuration working for this user", which is the question a
clinician or a user actually has, and it is honest about not answering
"how good is EMG switching."

Generalisation would need multiple participants and a controlled setup, i.e. a
study. This is the opposite: a procedure any user or clinician can run with the
library they already have, producing a number they can act on and a record they
can compare against their own past sessions.

**It cannot be run from the library alone.** Ground-truth labelling is human
work. No instrumentation distinguishes "the user meant that" from "the detector
thought they meant that" — that is the entire problem, and code cannot close it.

**It is not a clinical assessment.** A switch assessment led by an occupational
therapist or AAC clinician is the correct process for selecting an access method.
This protocol measures a configured system; it does not evaluate a person.

---

## 5. Why per-trial metrics are not enough on their own

SITbench-style metrics answer "when a target was presented, did the user hit
it?" — a closed-world question with a known trial count. Switch use in a
living room is open-world: nothing announces targets, the device is armed while
the user does something else, and the failure that matters is the activation
nobody asked for. FP/(FP+TN) has no way to express "it fired during dinner."

That is why the per-hour rate is the missing metric, and why it needs a
different procedure rather than a different formula.

---

## 6. Sources

Verified by search; each marked with what it supports.

| Claim | Source | Confidence |
|---|---|---|
| No standardised per-hour switch benchmark; the field reports speed and assessment | Koester et al. 2025, *AAC* 41(3):304-317, DOI 10.1080/07434618.2025.2499676 — synthesises 57 speed studies, 33 assessment papers; states evidence is "emerging" | high |
| SITbench defines accuracy / precision / recall / FPR = FP/(FP+TN) per trial | Esiyok & Albayrak 2019, *J Healthcare Eng* 2019:5075163, PMC6721442. **Correction notice: PMC6900938** | high |
| SAM is a 16-item paediatric functional assessment, not a metric set | Nguyen, Tilbrook, Sandelance, Wright 2023, *DRAT* 18(5):673-684, DOI 10.1080/17483107.2021.1906961 | high |
| Scanning error rule of thumb: revise at >25% of correct selections | Koester 2014, *JRRD* 51(6), JRRD-2013-09-0201 | high on the rule; medium on surrounding method (full text not retrievable) |
| Scan rate ≈ 0.65 × user response time | Simpson & Koester 2007, *Assistive Technology*, DOI 10.1080/10400435.2007.10131865 | high |
| EMG switch: more false positives than comparison, affecting usability; no per-hour rate | Judge et al. 2025, *DRAT*, DOI 10.1080/17483107.2025.2501746, PMID 40366772 | high on the finding, medium on participant counts (paywalled) |
| False activation is an open named problem in EMG-HCI | Eddy et al. 2023, CHI '23 art. 145, DOI 10.1145/3544548.3580962; Eddy et al. 2025, *J Neural Eng* 22:016006 | high |
| Users prefer false negatives to false positives | Lafreniere, Jonker et al. 2021, UIST, DOI 10.1145/3472749.3474735 | high |
| Sip-and-puff: no published false-activation rate exists | Two independent search angles returned only vendor pages and FAQs | high that the gap is real |
| Per-hour FP rates are conventional in adjacent fields | fall-sensor literature (0.025 FP/hour); bioacoustic detection, *Biological Reviews* DOI 10.1111/brv.13155 | medium (abstract-level) |

### Searches that returned nothing, which is the evidence

The gap claim rests on failed searches as much as successful ones. Angles tried
that produced no per-hour switch-access rate:

- "assistive technology switch user study reported false activation rate per hour"
- "unintended switch activation rate assistive technology measurement per hour"
- "'per hour' false positive rate switch scanning AAC user evaluation"
- "'false activation' switching assistive technology quantified measurement standard gap"
- "assistive switch access clinical trial false positive activation rate outcome measure published benchmark"
- "ISO standard assistive technology switch activation force error rate" — returns IEC 62304 (medical device software lifecycle); no switch error-rate standard exists
- "head pointer switch access accuracy error rate evaluation study" — returns pointer accuracy, not false activation
- "Midas touch assistive eye gaze quantified false selection rate per minute" — qualitative literature only

### Corrections applied to this project's own notes

Recorded because a protocol that cites carelessly is worse than one that cites
nothing:

1. **"SAM" was wrong** in the project's notes as "single access method / metric
   set." It is the Switch Access Measure. Fixed here and in the README.
2. **"SITbench" was right**, including its four metrics — confirmed against the
   full text, with a correction notice to carry.
3. **The Collins 2020 citation was flagged as a mis-citation and kept.** The
   paper (PMC7533965) is an electrophysiology reference with no AT content — but
   `analog.js` cites it for two facts it does state: the 2σ-above-baseline onset
   criterion, and that sub-50 ms bursts are frequent in appendicular muscles.
   Verified in the source: markers were assigned when the signal "increased by 2
   standard deviations above baseline," and "EMG bursts of duration <50
   milliseconds were frequently observed, particularly in appendicular muscles."
   No AT claim is derived from it, so the scope note in `analog.js` is the right
   fix rather than deletion. Anyone "correcting" this by removing the citation
   should read the 50 ms judgement first — it depends on it.
4. **"Communicating about switch access" does not exist.** The nearest real
   document is Judge & Colven, *Switch access to technology — A comprehensive
   Guide* (2006).
5. **Koester & Levine's word-prediction work is verified; a Koester & Levine
   paper specifically on switch timing and error rates was not found.** Do not
   cite one.

---

## 7. If you run this

The result is worth having whether or not it is flattering. A false-activation
rate that is worse than expected is a usable finding; the current state is that
nobody knows what to expect, which is worse for everyone using a switch.

If you run it and want the result recorded, it belongs in this repository as a
data point with its full condition set — not as a headline number, and not
without the denominator.
