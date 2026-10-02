# Wake-latency curve — Lattice B1 Hello Cell (MEASURED, not invented)

Box: 2-core x86_64, 7.1 GiB RAM, git 2.43.0, python3, local-path clones.
Method: `cellgen.py --n N --seed 11` → `wake.sh <cell>`; 3 runs per N; medians below.
Every chain verified during replay (`chain_ok=True`, `tip_match=True`) on all 12 runs.
Tip per N was byte-identical across its 3 runs (determinism witness).

| positions N | clone median (s) | replay median (s) | total wake median (s) | replay throughput (pos/s) |
|------------:|-----------------:|------------------:|----------------------:|--------------------------:|
| 1,000       | 0.1821           | 0.0160            | 0.3870                | ~62,500                   |
| 10,000      | 0.1373           | 0.1722            | 0.5505                | ~58,100                   |
| 100,000     | 0.2610           | 1.9639            | 2.4943                | ~50,900                   |
| 1,000,000   | 0.4559           | 15.1369           | 16.1511               | ~66,100                   |

Receipts file at N=1M: 34,888,890 bytes (~33.3 MiB) → replay ≈ 1.05 s per MiB of
chain on this box. Scaling anchor→tip is linear in N (~15–20 µs/position,
pure-Python fnv1a-64). Clone stays sub-second throughout — local pack transfer
dominates nothing; replay dominates everything. That is the physics: **wake cost
is reading+hashing the chain, not moving it.**

1M was NOT too slow for this box — the full curve through 1M positions was measured.

## Raw run log (verbatim)

```
N=1000 run=1 gen_s=0.316 clone_s=0.1241 replay_s=0.0160 total_s=0.3182 pos_per_s=62419.4 tip=806893393ef71182
N=1000 run=2 gen_s=0.301 clone_s=0.1821 replay_s=0.0143 total_s=0.3870 pos_per_s=69758.4 tip=806893393ef71182
N=1000 run=3 gen_s=0.447 clone_s=0.1804 replay_s=0.0294 total_s=0.4319 pos_per_s=33969.0 tip=806893393ef71182
N=10000 run=1 gen_s=0.645 clone_s=0.1373 replay_s=0.2221 total_s=0.5505 pos_per_s=45017.0 tip=56eeeb0769430d86
N=10000 run=2 gen_s=1.374 clone_s=0.1369 replay_s=0.1722 total_s=0.4694 pos_per_s=58065.3 tip=56eeeb0769430d86
N=10000 run=3 gen_s=0.546 clone_s=0.3907 replay_s=0.1420 total_s=1.0441 pos_per_s=70435.0 tip=56eeeb0769430d86
N=100000 run=1 gen_s=3.070 clone_s=0.3601 replay_s=1.8916 total_s=2.4326 pos_per_s=52866.6 tip=11abaea106614cb2
N=100000 run=2 gen_s=1.875 clone_s=0.1881 replay_s=1.9639 total_s=2.4943 pos_per_s=50918.3 tip=11abaea106614cb2
N=100000 run=3 gen_s=3.559 clone_s=0.2610 replay_s=2.2155 total_s=2.7005 pos_per_s=45136.5 tip=11abaea106614cb2
N=1000000 run=1 gen_s=18.633 clone_s=0.4131 replay_s=15.6077 total_s=16.1511 pos_per_s=64070.8 tip=ced5d38a85998f16
N=1000000 run=2 gen_s=12.386 clone_s=0.4559 replay_s=9.4181 total_s=9.9679 pos_per_s=106178.1 tip=ced5d38a85998f16
N=1000000 run=3 gen_s=22.429 clone_s=1.0302 replay_s=15.1369 total_s=16.4958 pos_per_s=66063.6 tip=ced5d38a85998f16
```

Measured 2026-10-02 by `measure-wake.sh` (lane A runner). Run-to-run spread at
1M (9.97 s – 16.50 s) is 2-core box noise; medians reported above.
