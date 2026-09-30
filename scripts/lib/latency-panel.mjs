const copy = {
  zh: {
    title: '预测回显测试',
    preset: '档位',
    custom: '自定义',
    rtt: '额外往返延迟',
    apply: '应用',
    hint: '模拟终端 · 两个方向各增加一半延迟。先输入一个字符等回显，再连续输入和退格。可在 WebUI 设置中切换预测“自动 / 始终开启 / 关闭”进行对比；自动模式的延迟估计需要几次回显更新。',
    active: '当前：',
    pending: '正在等待旧输入完成并切换…',
    failed: '设置失败：',
  },
  en: {
    title: 'Predictive echo test',
    preset: 'Preset',
    custom: 'Custom',
    rtt: 'Added round-trip delay',
    apply: 'Apply',
    hint: 'Simulated terminal · Half the delay is added in each direction. Type one character and wait for its echo, then type and backspace. Compare Auto / Always On / Off in WebUI settings; Auto needs a few echoes to update its latency estimate.',
    active: 'Active: ',
    pending: 'Waiting for queued input, then switching…',
    failed: 'Could not apply: ',
  },
};
let language = new URL(location.href).searchParams.get('lang') === 'en' ? 'en' : 'zh';
let currentMs = 0;
let busy = false;
const controls = document.querySelector('#controls');
const preset = document.querySelector('#preset');
const input = document.querySelector('#latency');
const status = document.querySelector('#status');
const render = () => {
  document.documentElement.lang = language;
  for (const node of document.querySelectorAll('[data-text]'))
    node.textContent = copy[language][node.dataset.text];
  document.querySelector('#language').textContent = language === 'zh' ? 'English' : '中文';
  status.textContent = busy ? copy[language].pending : `${copy[language].active}${currentMs} ms`;
};
const request = async (url, options) => {
  const response = await fetch(url, options);
  const body = await response.json();
  if (!response.ok) throw new Error(body.message);
  return body;
};
const reflect = () => {
  input.value = String(currentMs);
  preset.value = [...preset.options].some((option) => option.value === input.value)
    ? input.value
    : 'custom';
  render();
};
const apply = async () => {
  if (busy || !controls.reportValidity()) return;
  busy = true;
  for (const node of controls.elements) node.disabled = true;
  render();
  try {
    const state = await request(`/__test__/latency?ms=${encodeURIComponent(input.value)}`, {
      method: 'POST',
    });
    currentMs = state.latencyMs;
    busy = false;
    reflect();
  } catch (error) {
    busy = false;
    reflect();
    status.textContent = copy[language].failed + error.message;
  } finally {
    for (const node of controls.elements) node.disabled = false;
  }
};
controls.addEventListener('submit', (event) => {
  event.preventDefault();
  void apply();
});
preset.addEventListener('change', () => {
  if (preset.value === 'custom') {
    input.focus();
    return;
  }
  input.value = preset.value;
  void apply();
});
input.addEventListener('input', () => {
  preset.value = 'custom';
});
document.querySelector('#language').addEventListener('click', () => {
  language = language === 'zh' ? 'en' : 'zh';
  render();
});
render();
try {
  const state = await request('/__test__/state');
  currentMs = state.latencyMs;
  input.max = String(state.maxLatencyMs);
  reflect();
  const pairing = await request('/__test__/pair', { method: 'POST' });
  document.querySelector('#webui').src = pairing.url;
} catch (error) {
  status.textContent = copy[language].failed + error.message;
}
