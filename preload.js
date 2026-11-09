'use strict';

/**
 * 设置窗口的预加载脚本。
 * 只暴露最小 API，渲染进程无法直接访问 Node / ipcRenderer。
 *
 * v1.4.0 新增（仍然全部是白名单方法）：
 *  - previewTheme / onTheme   主题解析与主进程推送
 *  - getWater / recordWater / clearWater  喝水记录
 *  - checkUpdate / openRelease  GitHub Release 更新检查
 */

const { contextBridge, ipcRenderer } = require('electron');

const api = {
  /** 读取当前设置：Promise<{ settings, meta }> */
  load: () => ipcRenderer.invoke('settings:load'),
  /** 保存设置：Promise<{ ok: true, settings } | { ok: false, error }> */
  save: (payload) => ipcRenderer.invoke('settings:save', payload),
  /** 取消（关闭窗口，不保存） */
  cancel: () => ipcRenderer.invoke('settings:cancel'),
  /** 保存成功后关闭窗口 */
  close: () => ipcRenderer.invoke('settings:close'),
  /** 预解析主题（实时预览，不落盘）：Promise<{ ok, theme }> */
  previewTheme: (appearance) =>
    ipcRenderer.invoke('settings:preview-theme', appearance),
  /** 订阅主进程主题变化；返回取消订阅函数。 */
  onTheme: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('theme:changed', listener);
    return () => ipcRenderer.removeListener('theme:changed', listener);
  },
  /** 今日喝水状态 */
  getWater: () => ipcRenderer.invoke('water:get'),
  /** 记录一次喝水（ml） */
  recordWater: (ml) => ipcRenderer.invoke('water:record', ml),
  /** 清空今日喝水记录 */
  clearWater: () => ipcRenderer.invoke('water:clear'),
  /** 检查 GitHub Release 更新 */
  checkUpdate: () => ipcRenderer.invoke('update:check'),
  /** 在系统浏览器打开 Release 页面（主进程校验 URL） */
  openRelease: (url) => ipcRenderer.invoke('update:open', url),
};

contextBridge.exposeInMainWorld('offwork', Object.freeze(api));
