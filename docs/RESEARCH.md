# The research question

Until this file existed, ADAAS was a well-measured system with no stated question.
That is a real gap and not a formality: without a question declared in advance,
every measurement is free to become evidence for whatever it happened to show, and
a reader has no way to tell a designed experiment from a favourable one after the
fact.

What follows is the question, the falsifiable claims that answer it, what each was
tested against, and — for the three that came out against prediction — what the
measurement said instead.

---

## Primary question

> **On a small, near-duplicate-dense document corpus, which parts of a
> retrieval-augmented assistant actually determine measurable quality — and can
> that be established without any dependency on a commercial model provider?**

Two halves, both necessary. The first is an attribution question: given a working
RAG system, where does the quality come from. The second is a methodological
constraint that shapes what can be answered at all — every number in this
repository must be reproducible from a fresh clone with no API key, which rules out
LLM-as-judge for anything reported.

The constraint is not a limitation being apologised for. It is the condition that
makes the attribution question answerable at all: a pipeline whose scores depend on
a vendor's model version and sampling temperature cannot be ablated, because no two
runs are the same experiment.

---

## Claim 1 — attribution

> **On a corpus of this size and shape, measurable retrieval quality is determined
> by (a) domain-authored index content and (b) a cross-encoder reranking stage. It
> is NOT determined by the retrieval implementation, the sentence-embedding model
> choice, or the chunking strategy.**

Falsifiable in both directions. If the hand-written retrieval implementation beat a
framework default, (a)/(b) would be incomplete. If the embedding model or chunking
had mattered, the negative half would be false.

**Tested by** `baselines/bench.js` — LangChain and LlamaIndex on the identical
report split, identical gold labels, identical graded judgements, identical scorer,
identical seeded bootstrap. Six configurations designed to isolate one variable at
a time.

**Result: supported, with one important qualification.**

| contribution to top-1 | value |
|---|---|
| the embedding model (bge-small over MiniLM) | +0.0556 |
| the 12 curated keywords per policy | **+0.1111** |
| turning off LangChain's default chunking | 0.0000 |
| ADAAS retrieval code over LangChain's | **0.0000** |
| the cross-encoder reranker | **+0.1111** |

The negative half holds cleanly and is the stronger finding. `lc-same-text`,
`lc-same-everything`, `li-same-text` and `adaas-dense` all reach top-1 0.7222 and
recall@5 1.0000, and the LangChain rows match ADAAS's MRR to four decimals at
0.8287. Not approximately — identically. The chunking step that most RAG tutorials
open with is a no-op here: 26 documents in, 26 chunks out, because every policy is
shorter than the default 1000-character chunk size.

**The qualification:** the reranker's +0.1111 is a point estimate whose paired
interval is [-0.3889, 0.1667] and **does not separate**. So half of claim 1's
positive half is not statistically established at n = 18. Only (a) — the curated
keyword lists — survives as an effect this corpus is large enough to see, and even
that has not had an interval computed against a no-keywords baseline.

**A prediction that was wrong.** The written expectation before running the
benchmark was that the embedding model would explain the gap, on the reasoning that
"we picked a better model" is a smaller and therefore likelier claim than "we built
a better retriever." The real answer is smaller still: the model was worth one
query in eighteen and *lost* on nDCG@5 (0.8215 → 0.7725) and on how often the top
result was relevant at all (0.8333 → 0.7222). Two rounds of this project were
spent selecting it.

---

## Claim 2 — the premise construction for groundedness

> **For a corpus containing near-duplicate document families, faithfulness
> verification is better served by contradiction detection against individual
> retrieved documents than by entailment against the concatenated context.**

Falsifiable by measuring all four combinations at a matched false-positive budget.

**Tested by** `npm run eval:answers -- --nli` — two signals crossed with two
premise constructions, thresholds set as quantiles of the 26 true corpus answers
only, so no detector ever saw a mutation.

**Result: supported, and the mechanism is legible.**

| detector | 0 FP | 1 FP | 2 FP | 3 FP | threshold at 0 FP |
|---|---|---|---|---|---|
| entailment, concatenated | 0.0667 | 0.0800 | 0.0867 | 0.0867 | 0.0019 |
| contradiction, concatenated | 0.1933 | 0.2600 | 0.3467 | 0.4333 | 0.9009 |
| entailment, per document | 0.0067 | 0.0667 | 0.0667 | 0.0733 | 0.0022 |
| contradiction, per document | **0.2533** | 0.3000 | 0.3400 | 0.3533 | **0.0708** |

The threshold column carries the finding. Against the concatenated premise, the
most-contradicted **true** sentence in the corpus scores 0.9009 — and the model is
correct: `policy_003_el_sl` says leave "can be carried forward within limits" while
`policy_003_cl`, in the same premise, says it cannot. Two true statements about two
leave types, concatenated into a premise that contradicts itself. Scoring per
document drops the usable threshold by a factor of twelve.

**Honest qualification, stated because the table shows it:** per-document is not
uniformly better. It wins at zero false positives (0.2533 against 0.1933) and loses
from one onwards (0.3533 against 0.4333 at three). Zero is the defensible operating
point for a check that runs in front of a user, so the claim is scoped to that
operating point rather than asserted generally.

**A second prediction that was wrong.** "Contradiction against the sentence's own
best-supporting document" was designed as the formulation that should beat both —
neither *does anything disagree* nor *does everything agree* but *does the document
this claim came from actually say it*. It is the **worst of the five** at 0.0133.
The argmax that selects the document runs over entailment scores near 0.01 which
carry no signal, so the document chosen is effectively arbitrary. The formulation
is not wrong in principle; it needs a support signal strong enough to rank
documents, and this model does not provide one.

---

## Claim 3 — what can be established without a vendor

> **The sensitivity of a faithfulness verifier can be established from inside the
> repository with no API key. The faithfulness of the system cannot.**

This is the claim that keeps the other two honest, and it is a claim about what is
*not* knowable from here.

**Tested by** the mutation suite: 150 deterministically unfaithful answers built
from the corpus in seven classes, three of which were declared undetectable by any
exact check *before* measuring, with the 26 true answers as a control.

**Result: both halves hold.**

| | |
|---|---|
| control — true answers flagged | **0 / 26** |
| changed_number | 1.0000 |
| entitlement_swap | 1.0000 |
| fabricated_citation | 1.0000 |
| swapped_number | 0.2737 |
| negated_requirement / imported_clause / dropped_condition | 0.0000 |
| exact checks, overall | 0.3867 |
| with entailment added | 0.5467 |

The second half is the part worth stating loudly: **nothing here measures how often
a real generation is wrong.** Stage 4 of the eval reports that the generative path
has never been exercised, and the report's own `about` field says the claim
direction is sensitivity and not faithfulness. A reader who came away thinking the
generative path had been validated would have been misled, and preventing that is
why the extractive path returns no verification verdict at all rather than a
trivially grounded one.

**A third prediction that was wrong**, and it is recorded in the file rather than
corrected: `swapped_number` was predicted at 0.60 on the assumption that a swapped
figure would usually land on a different leave pool where the authoritative table
could catch it. Measured 0.2737. The corpus states entitlements as a bare
"Entitlement: N days per year" with the leave type in the document title rather than
the sentence, so there is nothing inside the sentence to bind the number to — and
the swap target is by construction a real corpus figure, so it is present in the
context and the unsupported-number check cannot see it either.

---

## What the answer to the primary question is

Stated in one paragraph, since that is what a research question is for:

> On a 26-document policy corpus, measurable retrieval quality came from
> hand-written domain knowledge (+0.1111 from curated keyword lists) and, by point
> estimate only, a cross-encoder reranker (+0.1111, interval spanning zero). The
> retrieval implementation contributed exactly zero against a framework default,
> to four decimals on every metric; the embedding model contributed one query in
> eighteen while losing graded relevance; chunking contributed nothing. The
> vendor-free constraint was satisfiable throughout, and it forced the answer-layer
> claim to be about verifier sensitivity (0.3867 exact, 0.5467 with entailment,
> 0 / 26 false positives) rather than about system faithfulness, which cannot be
> established from here at all.

## What is deliberately not answered

Three questions are within reach of the machinery already in this repository and
are **reserved** rather than left undone — see
[Reserved for the capstone](../README.md#reserved-for-the-capstone) for the rule
distinguishing the two.

1. **How many queries are needed to detect a five-point difference at this observed
   variance.** A power analysis using the bootstrap already here. This is the
   constructive form of "the corpus is small", and it is the number that would say
   what to build next. [Voorhees & Buckley (SIGIR 2002)](https://dl.acm.org/doi/10.1145/564376.564432)
   is the reference, and by their standards most differences measured here are not
   measurable at n = 18.
2. **How much of the graded score is annotator noise.** `npm run annotate` produces
   a blind sheet and computes Cohen's kappa, both exercised end to end. There is
   one annotator, who also tuned the retriever. That cannot be fixed from inside.
3. **Whether a metric that depends on a vendor can be reported honestly** — what
   must be pinned, what disclosed, what a reader can still check. This project has
   an unusually strong position from which to ask it, having spent its whole history
   refusing to let numbers drift, and answering it would require breaking the
   constraint that makes claim 3 possible.

## The rule this document is under

A claim moves to *supported* only with a number and an interval attached. A
prediction that fails stays in the file with its original value and the reason it
failed, and is never edited to match what was measured — `PREDICTIONS` and `FLOORS`
in `scripts/eval_answers.js` are separate objects for exactly this reason.

Three of the predictions on this page were wrong. That is the part of it most worth
a reader's time.
