// 全站统一 Toast 入口，封装 react-hot-toast
// 业务代码请用 toastOk / toastErr / toastInfo / toastLoading / toastDismiss
import toast from "react-hot-toast";

export const toastOk = (msg: string) => toast.success(msg);
export const toastErr = (msg: string) => toast.error(msg);
export const toastInfo = (msg: string) => toast(msg);
export const toastLoading = (msg: string) => toast.loading(msg);
export const toastDismiss = (id?: string) => toast.dismiss(id);
