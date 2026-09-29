/** 配置项：Node 下读环境变量（.env），浏览器里由页面设置（setConfig） */
const env = globalThis.process?.env ?? {};
const overrides = {};

export function setConfig(values) {
  Object.assign(overrides, values);
}

export function cfg(key) {
  const v = overrides[key] ?? env[key];
  return v === '' ? undefined : v;
}
