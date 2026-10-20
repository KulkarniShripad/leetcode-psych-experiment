# The planned analysis on participants.csv.
# Usage: Rscript scripts/analysis/ancova.R data/exports/<timestamp>/participants.csv

args <- commandArgs(trailingOnly = TRUE)
df <- read.csv(args[1], stringsAsFactors = FALSE)
df <- subset(df, status == "completed")
cat("Completed participants:", nrow(df), "\n")
print(table(df$arm))

alpha <- function(items) {
  items <- na.omit(items)
  k <- ncol(items)
  k / (k - 1) * (1 - sum(apply(items, 2, var)) / var(rowSums(items)))
}
cat("\n1. Cronbach's alpha C1-C6: pre =", round(alpha(df[paste0("C", 1:6, "_pre")]), 3),
    " post =", round(alpha(df[paste0("C", 1:6, "_post")]), 3), "\n")

cat("\n2. Confidence by group\n")
print(aggregate(cbind(pre_conf_mean, post_conf_mean, conf_change, score_raw) ~ arm, data = df, FUN = mean))
model <- lm(post_conf_mean ~ arm_code + pre_conf_mean, data = df)  # H1: positive arm_code
print(summary(model))
print(anova(lm(post_conf_mean ~ arm_code * pre_conf_mean, data = df)))  # slopes check

cat("\n3. Calibration (Q10 - score) by group\n")
print(aggregate(calibration_gap ~ arm, data = df, FUN = mean))

cat("\n4. Manipulation check (Q12)\n")
print(table(df$arm, df$Q12_label))

cat("\n5. Q11, Q13, Q14 by group\n")
for (item in intersect(c("Q11", "Q13", "Q14"), names(df))) {
  print(item)
  print(wilcox.test(df[[item]] ~ df$arm))
}
print(table(df$arm, df$P1_label))
print(table(df$arm, df$P2_label))
