"""The planned analysis on participants.csv.

Usage:  pip install pandas statsmodels scipy
        python3 scripts/analysis/ancova.py data/exports/<timestamp>/participants.csv

1. Reliability of C1-C6 (Cronbach's alpha), before and after.
2. Main test (H1): ANCOVA  post_conf_mean ~ arm_code + pre_conf_mean, with F, partial eta
   squared and adjusted means for reporting, plus the slopes check.
3. Manipulation check (Q12) by group.
4. Q11, Q13, Q14 by group, and P1/P2 balance between the groups.
"""
import sys

import pandas as pd
import statsmodels.api as sm
import statsmodels.formula.api as smf
from scipy import stats

pd.set_option("display.width", 200)
pd.set_option("display.max_columns", None)


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
summary = df.groupby("arm")[["pre_conf_mean", "post_conf_mean", "conf_change", "score_raw"]].agg(["mean", "std"]).round(2)
summary.insert(0, "n", df.groupby("arm").size())
print(summary)
model = smf.ols("post_conf_mean ~ arm_code + pre_conf_mean", data=df).fit()
print(model.summary().tables[1])
table = sm.stats.anova_lm(model, typ=2)
ss_arm, ss_resid = table.loc["arm_code", "sum_sq"], table.loc["Residual", "sum_sq"]
f, p = table.loc["arm_code", "F"], table.loc["arm_code", "PR(>F)"]
eta = ss_arm / (ss_arm + ss_resid)
mean_pre = df["pre_conf_mean"].mean()
adjusted = model.predict(pd.DataFrame({"arm_code": [0, 1], "pre_conf_mean": [mean_pre, mean_pre]}))
print(f"   ANCOVA: F(1, {int(model.df_resid)}) = {f:.2f}, p = {p:.4f}, partial eta squared = {eta:.3f}")
print(f"   Adjusted post means (at pre = {mean_pre:.2f}): control {adjusted[0]:.2f}, experimental {adjusted[1]:.2f}")
print(f"   H1 (experimental gains more confidence): adjusted difference = {model.params['arm_code']:.3f} points")
slopes = smf.ols("post_conf_mean ~ arm_code * pre_conf_mean", data=df).fit()
print(f"   Homogeneity of slopes (should be non-significant): interaction p = {slopes.pvalues['arm_code:pre_conf_mean']:.3f}")

print("\n3. Manipulation check: Q12 'did you see badges, tokens or a leaderboard?'")
print(pd.crosstab(df["arm"], df["Q12_label"]))

print("\n4. Other post items by group (Mann-Whitney U)")
for item in ("Q11", "Q13", "Q14"):
    if item not in df:
        continue
    groups = [g[item].dropna() for _, g in df.groupby("arm")]
    u = stats.mannwhitneyu(*groups) if len(groups) == 2 else None
    means = df.groupby("arm")[item].mean().round(2).to_dict()
    print(f"   {item}: means {means}" + (f", p = {u.pvalue:.4f}" if u else ""))

print("\n   Balance at baseline (P1 problems solved, P2 practice frequency):")
for item in ("P1", "P2"):
    order = df.sort_values(item)[f"{item}_label"].dropna().unique()
    print(pd.crosstab(df["arm"], df[f"{item}_label"])[order])
