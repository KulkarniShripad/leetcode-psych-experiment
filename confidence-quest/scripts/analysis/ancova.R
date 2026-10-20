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
# F test for the group adjusted for pre (pre entered first), partial eta squared, adjusted means.
tab <- anova(lm(post_conf_mean ~ pre_conf_mean + arm_code, data = df))
print(tab)
cat("partial eta squared:", round(tab["arm_code", "Sum Sq"] / (tab["arm_code", "Sum Sq"] + tab["Residuals", "Sum Sq"]), 3), "\n")
at <- data.frame(arm_code = c(0, 1), pre_conf_mean = mean(df$pre_conf_mean))
cat("adjusted post means (control, experimental):", round(predict(model, at), 2), "\n")
print(anova(lm(post_conf_mean ~ arm_code * pre_conf_mean, data = df)))  # slopes check

cat("\n3. Manipulation check (Q12)\n")
print(table(df$arm, df$Q12_label))

cat("\n4. Q11, Q13, Q14 by group\n")
for (item in intersect(c("Q11", "Q13", "Q14"), names(df))) {
  print(item)
  print(wilcox.test(df[[item]] ~ df$arm))
}
print(table(df$arm, df$P1_label))
print(table(df$arm, df$P2_label))
