/** 一次性提示条分片。 */
import type { SliceCreator, ToastSlice } from './types'

let toastSeq = 0

export const createToastSlice: SliceCreator<ToastSlice> = (set, get) => ({
  toasts: [],

  toast: (kind, title, detail) => {
    const id = ++toastSeq
    set((state) => ({ toasts: [...state.toasts.slice(-3), { id, kind, title, detail }] }))
    setTimeout(() => get().dismissToast(id), 5000)
  },

  dismissToast: (id) =>
    set((state) => ({ toasts: state.toasts.filter((toast) => toast.id !== id) }))
})
