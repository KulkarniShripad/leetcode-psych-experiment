"""The planned analysis on participants.csv.

Usage:  pip install pandas statsmodels scipy
        python3 scripts/analysis/ancova.py data/exports/<timestamp>/participants.csv

1. Reliability of C1-C6 (Cronbach's alpha), before and after.
2. Main test (H1): ANCOVA  post_conf_mean ~ arm_code + pre_conf_mean, plus the slopes check.
3. Calibration (Q10 - score) by group.
4. Manipulation check (Q12) by group.
5. Q11, Q13, Q14 by group, and P1/P2 balance between the groups.
"""
import sys

import pandas as pd
import statsmodels.formula.api as smf
from scipy import stats


def cronbach_alpha(items: pd.DataFrame) -> float:
    items = items.dropna()
    k = items.shape[1]
    return k / (k - 1) * (1 - items.var(ddof=1).sum() / items.sum(axis=1).var(ddof=1))


df = pd.read_csv(sys.argv[1])
df = df[df["status"] == "completed"].copy()
print(f"Completed participants: {len(df)}  ({df['arm'].value_counts().to_dict()})\n")

conf = [f"C{i}" for i in range(1, 7)]
print("1. Reliability of C1-C6")
for phase in ("pre", "post"):
    print(f"   Cronbach's alpha ({phase}): {cronbach_alpha(df[[f'{c}_{phase}' for c in conf]]):.3f}")

print("\n2. Confidence by group")
print(df.groupby("arm")[["pre_conf_mean", "post_conf_mean", "conf_change", "score_raw"]].agg(["count", "mean", "std"]).round(3))
model = smf.ols("post_conf_mean ~ arm_code + pre_conf_mean", data=df).fit()
print(model.summary().tables[1])
b, p = model.params["arm_code"], model.pvalues["arm_code"]
print(f"   H1 (experimental gains more confidence): adjusted difference = {b:.3f} points, p = {p:.4f}")
slopes = smf.ols("post_conf_mean ~ arm_code * pre_conf_mean", data=df).fit()
print(f"   Homogeneity of slopes (should be non-significant): interaction p = {slopes.pvalues['arm_code:pre_conf_mean']:.3f}")

print("\n3. Calibration (Q10 guess - actual score; + = overestimate)")
print(df.groupby("arm")["calibration_gap"].agg(["mean", "std"]).round(3))
print(f"   |gap| by group: {df.assign(abs_gap=df['calibration_gap'].abs()).groupby('arm')['abs_gap'].mean().round(3).to_dict()}")

print("\n4. Manipulation check: Q12 'did you see badges, tokens or a leaderboard?'")
print(pd.crosstab(df["arm"], df["Q12_label"]))

print("\n5. Other post items by group (Mann-Whitney U)")
for item in ("Q11", "Q13", "Q14"):
    if item not in df:
        continue
    groups = [g[item].dropna() for _, g in df.groupby("arm")]
    u = stats.mannwhitneyu(*groups) if len(groups) == 2 else None
    means = df.groupby("arm")[item].mean().round(2).to_dict()
    print(f"   {item}: means {means}" + (f", p = {u.pvalue:.4f}" if u else ""))

print("\n   Balance at baseline (P1 problems solved, P2 practice frequency):")
for item in ("P1_label", "P2_label"):
    print(pd.crosstab(df["arm"], df[item]))
