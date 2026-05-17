// 全站统一 Toast 入口，封装 react-hot-toast
// 业务代码请用 toastOk / toastErr / toastInfo / toastLoading / toastDismiss
import React from "react";
import toast from "react-hot-toast";

export const toastOk = (msg: string) => toast.success(msg);
export const toastErr = (msg: string) => toast.error(msg);
export const toastInfo = (msg: string) => toast(msg);
export const toastLoading = (msg: string) => toast.loading(msg);
export const toastDismiss = (id?: string) => toast.dismiss(id);

/**
 * AI 点数不足专用提示：红色卡片 + 一个「去充值」按钮跳到个人中心余额卡。
 * 替代各 AI 页零散的 toastErr(`余额不足：...`)——给用户明确的下一步引导。
 * detail 一般是后端 402 的 detail（"余额不足：当前 X 点，本次需 Y 点"）。
 */
export const toastInsufficientCredits = (detail?: string) => {
  toast.custom(
    (t) =>
      React.createElement(
        "div",
        {
          className:
            "max-w-sm w-full bg-white dark:bg-zinc-900 border border-danger-200 " +
            "dark:border-danger-800 shadow-lg rounded-xl px-4 py-3 flex items-start gap-3",
          role: "alert",
        },
        React.createElement(
          "div",
          { className: "flex-1 min-w-0" },
          React.createElement(
            "p",
            { className: "text-sm font-semibold text-danger-600 dark:text-danger-400" },
            "AI 点数不足",
          ),
          React.createElement(
            "p",
            { className: "text-xs text-default-500 mt-0.5 break-words" },
            detail || "本次操作需要的点数超过当前余额",
          ),
        ),
        React.createElement(
          "a",
          {
            href: "/dashboard/profile",
            className:
              "shrink-0 text-xs font-medium px-3 py-1.5 rounded-lg bg-danger-500 " +
              "text-white hover:bg-danger-600 transition-colors",
            onClick: () => toast.dismiss(t.id),
          },
          "去充值",
        ),
      ),
    { duration: 8000 },
  );
};
