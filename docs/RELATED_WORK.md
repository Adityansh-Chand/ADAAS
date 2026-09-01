# Related work, and what this project actually contributes

Every number in this repository was produced by comparing ADAAS to ADAAS. That is
enough to say a change helped; it is not enough to say the result is worth
anything, because a comparison with no external reference cannot distinguish
"we built something good" from "we reinvented a default and measured it
carefully."

This document places each part of the system against published work and states,
for each, whether the technique is standard, whether the result is competitive,
and whether any claim is being made at all. The short version, stated up front so
nobody has to read to the end for it:

> **Nothing in this project's retrieval is novel, and the benchmark in
> `baselines/` shows most of it is reproducible by a framework default. The one
> thing that may be worth a reader's attention is the evaluation protocol — and
> even that is mostly the careful application of practices the IR community has
> been asking for since 2002.**

## 1. Retrieval

### What ADAAS does

A bi-encoder (`bge-small-en-v1.5`) over 26 policy documents, cosine similarity,
then a cross-encoder (`mxbai-rerank-xsmall-v1`) reordering the top 10. Lexical
IDF-weighted phrase matching as a fallback, and reciprocal rank fusion of the two
as an option that does not win.

### Where that sits

This is the standard two-stage pipeline. Dense retrieval with a dual encoder is
DPR ([Karpukhin et al., EMNLP 2020](https://aclanthology.org/2020.emnlp-main.550/));
the sentence-embedding formulation is Sentence-BERT
([Reimers & Gurevych, EMNLP 2019](https://aclanthology.org/D19-1410/)); the
cross-encoder reranking stage is
[Nogueira & Cho (2019)](https://arxiv.org/abs/1901.04085). The specific model is
from the BGE family, released as part of
[C-Pack (Xiao et al., SIGIR 2024)](https://dl.acm.org/doi/10.1145/3626772.3657878) —
which is also the source of the asymmetric query prefix this project treats as
part of the model contract rather than a stylistic choice. Reciprocal rank fusion
is [Cormack, Clarke & Buettcher (SIGIR 2009)](https://dl.acm.org/doi/10.1145/1571941.1572114).
The evaluation metric, nDCG, is
[Järvelin & Kekäläinen (TOIS 2002)](https://dl.acm.org/doi/10.1145/582415.582418).

`BEIR` ([Thakur et al., NeurIPS 2021 Datasets](https://arxiv.org/abs/2104.08663))
is the reference point for zero-shot retrieval quality, and `MTEB`
([Muennighoff et al., EACL 2023](https://aclanthology.org/2023.eacl-main.148/)) for
embedding model selection. Both report a finding this project independently
reproduced: reranking a dense candidate list is one of the few reliably positive
interventions, while most other pipeline elaborations are corpus-dependent.

### What claim is being made

**None.** Three reasons, and they are disqualifying rather than mitigating:

1. **Scale.** BEIR's smallest corpus has thousands of documents. This has 26. A
   top-1 of 0.8333 on 26 candidates is not comparable to any published number and
   should not be quoted beside one.
2. **The gains are not this project's.** `baselines/bench.js` scores LangChain and
   LlamaIndex on the identical split with the identical scorer. Four
   configurations — `lc-same-text`, `lc-same-everything`, `li-same-text` and
   `adaas-dense` — tie at top-1 0.7222 and recall@5 1.0000, and the LangChain rows
   match ADAAS's MRR to four decimals at 0.8287. The hand-written dense path is a
   framework default.
3. **The model selection was worth almost nothing.** bge-small over MiniLM moved
   top-1 by one query in eighteen and *lost* on nDCG@5 (0.8215 → 0.7725) and on
   how often the top result was relevant at all (0.8333 → 0.7222).

Two papers describe exactly this pattern, and this project is an instance of it
rather than an exception to it.
[Armstrong, Moffat, Webber & Zobel (CIKM 2009)](https://dl.acm.org/doi/10.1145/1645953.1646031)
showed that a decade of reported ad-hoc retrieval improvements did not accumulate,
largely because researchers compared against their own previous systems rather than
against strong external baselines — which is precisely what every ADAAS number did
until `baselines/` existed.
[Musgrave, Belongie & Lim (ECCV 2020)](https://www.ecva.net/papers/eccv_2020/papers_ECCV/papers/123700681.pdf)
found the same for metric learning: years of claimed gains shrank to marginal
under a level playing field.

The honest reading is that the largest measurable contribution in this project's
retrieval is the **twelve curated keywords per policy** (+0.1111 top-1, same
framework and same model) — hand-written domain knowledge, not retrieval
engineering, and something no default recipe provides.

## 2. The answer layer

### What ADAAS does

Three exact checks in the request path — unsupported quantities, entitlement
figures bound to the wrong leave pool, and citations naming documents that were
never retrieved — plus an offline entailment/contradiction stage. Sensitivity is
measured against 150 deterministically generated unfaithful answers in seven
classes, with the 26 true corpus answers as a zero-false-positive control.

### Where that sits

The framing is RAG ([Lewis et al., NeurIPS 2020](https://arxiv.org/abs/2005.11401)).
The decomposition into faithfulness, answer relevance and context relevance is
[RAGAS (Es et al., EACL 2024 demo)](https://aclanthology.org/2024.eacl-demo.16/),
which is the closest published work to what `scripts/eval_answers.js` does.
`ARES` ([Saad-Falcon et al.](https://arxiv.org/abs/2311.09476)) is the same task
with trained judges. Atomic-claim decomposition and per-claim verification is
`FActScore` ([Min et al., EMNLP 2023](https://arxiv.org/abs/2305.14251)). The
underlying hallucination taxonomy is
[Ji et al. (ACM CSUR 2023)](https://dl.acm.org/doi/10.1145/3571730).

The NLI-based approach specifically is
[SummaC (Laban et al., TACL 2022)](https://aclanthology.org/2022.tacl-1.10/), and
this matters more than a citation, because SummaC's central finding predicts one
of this project's:

> SummaC showed that earlier NLI-based inconsistency detection underperformed
> because of a **granularity mismatch** — NLI models are trained on sentence pairs
> and were being applied to whole documents — and that segmenting and aggregating
> at sentence level fixes it.

`eval_answers.js` hit the same wall from the other side. Scoring an answer
sentence against the *concatenated* five-document context put the false-positive
threshold at contradiction > 0.9009, because the most-contradicted **true**
sentence in the corpus is `policy_003_el_sl`'s "Can be carried forward within
limits" — and the model is right, since the same premise also contains
`policy_003_cl` saying leave cannot be carried forward. Scoring per document drops
that threshold to 0.0708, a factor of twelve.

That is a *premise*-side granularity mismatch where SummaC identified a
hypothesis-side one, and the mechanism is specific to this kind of corpus:
**a retriever doing its job on a near-duplicate family builds a premise that
contradicts itself.** Twelve of these 26 documents belong to two such families.
This is offered as corroboration of SummaC in a new setting rather than as a
discovery — the phenomenon follows directly from their analysis once stated.

### Where the results differ from common practice

Two findings ran against expectation and are recorded in
`eval/answer_report.json`:

- **Contradiction beats entailment by three to four times** at every
  false-positive budget and in every premise construction; entailment tops out at
  0.0867 and is near-useless here. This is worth flagging because entailment
  probability is what groundedness checks are normally built on — no true answer
  in this corpus scores above 0.0703 entailment against its own source, so the
  question "is this supported" gets an unusable answer from a model that answers
  "does the source say the opposite" perfectly well on the same forward pass.
- **A designed refinement failed.** Contradiction scored against the sentence's
  own best-supporting document was expected to beat both aggregations and is the
  worst of five (0.0133 at zero false positives), because the argmax selecting
  that document runs over entailment scores near 0.01 that carry no signal.

### What claim is being made

A narrow one, and the direction matters. This measures the **sensitivity of a
verifier** against known-wrong answers. It does **not** measure the faithfulness
of the system, which would need real generations, which would need an API key and
a vendor and a temperature. Stage 4 of the eval says the generative path has never
been exercised. A reader must not be able to leave with the second claim.

The mutation-suite construction is standard software engineering applied to an
unusual target: mutation testing is
[DeMillo, Lipton & Sayward (1978)](https://ieeexplore.ieee.org/document/1646911),
surveyed by [Jia & Harman (TSE 2011)](https://ieeexplore.ieee.org/document/5487526).
The transfer here is that the mutants are injected into the *data* to test an
*evaluation metric*, rather than into code to test a test suite. That is closer to
metamorphic testing of ML systems than to classical mutation testing, and it is a
recombination of known techniques rather than a new one.

## 3. Abstention

Rejecting 12 of 12 plainly off-domain questions and **2 of 12** HR-shaped
questions the corpus cannot answer, after four signals failed on the hard tier
(dense cosine, cross-encoder logit, term coverage, NLI entailment).

This is the well-documented hard case. `SQuAD 2.0`
([Rajpurkar, Jia & Liang, ACL 2018](https://aclanthology.org/P18-2124/)) exists
because systems that answer answerable questions well fail to abstain on
unanswerable ones, and the gap has never closed cleanly. `RGB`
([Chen, Lin, Han & Sun, AAAI 2024](https://ojs.aaai.org/index.php/AAAI/article/view/29728))
evaluates RAG systems on exactly this axis under the name **negative rejection**
and reports it as among the weakest capabilities measured.

The diagnosis recorded in the README is consistent with that literature and worth
restating because it explains why a fifth similarity signal will not help: all
four failed signals measure similarity, and *the corpus discusses this* is
maximally similar to *the corpus answers this*. "How many days of paternity leave
does the law require" scores higher than most genuine queries precisely because
there is a paternity policy.

## 4. Statistical practice

This is the only section where the project is arguably ahead of common practice
rather than behind it, and it is still short of the field's own standard.

Reporting a bootstrap confidence interval beside every headline number, and a
*paired* interval for every comparison, follows
[Smucker, Allan & Carterette (CIKM 2007)](https://dl.acm.org/doi/10.1145/1321440.1321528),
who recommended the bootstrap and Fisher randomization over the t-test and
Wilcoxon for IR evaluation. Doing so caught a claim this project would otherwise
have published: reranked beats dense by +0.1111 top-1 with interval
[-0.1667, 0.3889], which **does not separate**. That headline was already written
before the interval was computed.

The limitation is named by
[Voorhees & Buckley (SIGIR 2002)](https://dl.acm.org/doi/10.1145/564376.564432),
who derived empirical error rates as a function of topic set size and found them
"larger than anticipated," warning specifically against concluding one method is
better than another from few topics. The report halves here are **n = 18 and
n = 13**. By that paper's own standards, most differences this project measures
are not measurable at this size, and the honest position is that several findings
sit inside their own intervals.

Turning that into a number — how many queries are needed to detect a five-point
difference at this observed variance — is a power analysis using machinery that
already exists here, and it is deliberately **reserved** rather than done; see
[Reserved for the capstone](../README.md#reserved-for-the-capstone).

Annotator agreement uses [Cohen (1960)](https://journals.sagepub.com/doi/10.1177/001316446002000104).
`npm run annotate` produces a blind sheet and computes kappa, both exercised end
to end, and there is still only one annotator — who also tuned the retriever.
That is not a gap in the plumbing, it is the definition of the problem, and it is
also reserved.

## 5. What is left

Stated plainly, because a related-work section that ends by discovering the author
was right anyway is not a related-work section.

**Not a contribution:** the retrieval pipeline, the embedding model choice, the
fusion strategy, the chunking decision, the answer-generation prompt. All standard,
and the benchmark shows the implementation is replaceable by a framework default at
identical scores.

**Possibly of interest to a reader:**

1. **A worked example of measuring a RAG system with no vendor in the loop.**
   Every reported number is reproducible from a fresh clone with no API key.
   The constraint is the interesting part: it forces a mutation-based sensitivity
   claim instead of a faithfulness claim, and forces the difference between those
   two to be stated rather than blurred.
2. **The self-contradicting-premise result**, as corroboration of SummaC's
   granularity argument in a setting — near-duplicate document families — where the
   effect is large, mechanical, and produced by the retriever working correctly.
3. **Selection hygiene enforced in code rather than by intention.** Six held-out
   intent sets with a written retirement rule, a selection harness that *throws*
   if asked to open a held-out file, a leakage gate that caught two of the
   author's own fixtures, and predictions recorded separately from regression
   floors so a wrong prediction stays visible instead of being edited to match its
   measurement. Armstrong et al.'s finding is what happens when this is left to
   good intentions.

**The finding most likely to be useful to somebody else**, and it is not
flattering: on a small policy corpus, the measurable difference between a
carefully hand-built retriever and twenty lines of LangChain is **zero**, and what
did move the number was writing keyword lists and adding a reranker. Anyone about
to hand-build retrieval plumbing for a corpus this size should read that as a
reason not to.

---

## References

All verified against the published record.

- Armstrong, Moffat, Webber & Zobel. *Improvements that don't add up: ad-hoc retrieval results since 1998.* CIKM 2009, 601–610.
- Chen, Lin, Han & Sun. *Benchmarking Large Language Models in Retrieval-Augmented Generation.* AAAI 2024, 17754–17762.
- Cohen. *A Coefficient of Agreement for Nominal Scales.* Educational and Psychological Measurement, 20(1), 1960.
- Cormack, Clarke & Buettcher. *Reciprocal rank fusion outperforms Condorcet and individual rank learning methods.* SIGIR 2009.
- DeMillo, Lipton & Sayward. *Hints on Test Data Selection: Help for the Practicing Programmer.* Computer, 11(4), 1978.
- Es, James, Espinosa-Anke & Schockaert. *RAGAs: Automated Evaluation of Retrieval Augmented Generation.* EACL 2024 (System Demonstrations).
- Järvelin & Kekäläinen. *Cumulated gain-based evaluation of IR techniques.* ACM TOIS, 20(4), 2002.
- Ji et al. *Survey of Hallucination in Natural Language Generation.* ACM Computing Surveys, 55(12), 2023.
- Jia & Harman. *An Analysis and Survey of the Development of Mutation Testing.* IEEE TSE, 37(5), 2011.
- Karpukhin et al. *Dense Passage Retrieval for Open-Domain Question Answering.* EMNLP 2020.
- Khattab & Zaharia. *ColBERT: Efficient and Effective Passage Search via Contextualized Late Interaction over BERT.* SIGIR 2020.
- Laban, Schnabel, Bennett & Hearst. *SummaC: Re-Visiting NLI-based Models for Inconsistency Detection in Summarization.* TACL 10:163–177, 2022.
- Lewis et al. *Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks.* NeurIPS 2020.
- Min et al. *FActScore: Fine-grained Atomic Evaluation of Factual Precision in Long Form Text Generation.* EMNLP 2023.
- Muennighoff, Tazi, Magne & Reimers. *MTEB: Massive Text Embedding Benchmark.* EACL 2023.
- Musgrave, Belongie & Lim. *A Metric Learning Reality Check.* ECCV 2020.
- Nogueira & Cho. *Passage Re-ranking with BERT.* arXiv:1901.04085, 2019.
- Rajpurkar, Jia & Liang. *Know What You Don't Know: Unanswerable Questions for SQuAD.* ACL 2018.
- Reimers & Gurevych. *Sentence-BERT: Sentence Embeddings using Siamese BERT-Networks.* EMNLP 2019.
- Saad-Falcon, Khattab, Potts & Zaharia. *ARES: An Automated Evaluation Framework for Retrieval-Augmented Generation Systems.* arXiv:2311.09476.
- Smucker, Allan & Carterette. *A comparison of statistical significance tests for information retrieval evaluation.* CIKM 2007, 623–632.
- Thakur, Reimers, Rücklé, Srivastava & Gurevych. *BEIR: A Heterogeneous Benchmark for Zero-shot Evaluation of Information Retrieval Models.* NeurIPS 2021 Datasets and Benchmarks.
- Voorhees & Buckley. *The effect of topic set size on retrieval experiment error.* SIGIR 2002, 316–323.
- Xiao, Liu, Zhang, Muennighoff, Lian & Nie. *C-Pack: Packed Resources For General Chinese Embeddings.* SIGIR 2024.
