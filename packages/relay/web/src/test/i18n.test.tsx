import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, renderHook, act, fireEvent } from '@testing-library/react';
import fs from 'node:fs';
import path from 'node:path';
import { useI18n } from '../i18n/useI18n';
import { translate } from '../i18n';
import { en } from '../i18n/en';
import { zh } from '../i18n/zh';
import { TerminalProvider } from '../context/TerminalContext';
import { describeConnection } from '../utils/connectionStatus';
import { MobileControlSheet } from '../components/MobileControlSheet';
import { ClientsTable } from '../components/admin/ClientsTable';
import { PtysTable } from '../components/admin/PtysTable';
import { TerminalView } from '../components/TerminalView';
import { KeyToolbar } from '../components/KeyToolbar';
import { SettingsModal } from '../components/SettingsModal';
import { Header } from '../components/Header';
import { getLocalizedKeyTitle, ALL_AVAILABLE_KEYS } from '../utils/virtualKeys';
import { saveSettings } from '../utils/storage';

describe('i18n Internationalization Infrastructure & Full Coverage', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
  });

  it('translates English and Chinese keys correctly', () => {
    expect(translate('en', 'header.appName')).toBe('Herdr');
    expect(translate('zh', 'header.appName')).toBe('Herdr');

    expect(translate('en', 'common.settings')).toBe('Settings');
    expect(translate('zh', 'common.settings')).toBe('设置');

    expect(translate('en', 'role.controllerMode')).toBe('Controller mode active');
    expect(translate('zh', 'role.controllerMode')).toBe('控制模式生效中');
  });

  it('handles parameter interpolation properly', () => {
    const enText = translate('en', 'toasts.clientIdCopied', { id: 'client-alpha' });
    expect(enText).toBe('Client ID copied: client-alpha');

    const zhText = translate('zh', 'toasts.clientIdCopied', { id: 'client-alpha' });
    expect(zhText).toBe('客户端 ID 已复制: client-alpha');

    const previewZh = translate('zh', 'settings.fontPreviewLabel', { size: 14 });
    expect(previewZh).toBe('字体效果实时预览 (14px)：');

    const previewEn = translate('en', 'settings.fontPreviewLabel', { size: 14 });
    expect(previewEn).toBe('Font Preview (14px):');
  });

  it('falls back to English when a key is undefined in target dictionary', () => {
    const result = translate('zh', 'nonExistentKey' as any);
    expect(result).toBe('nonExistentKey');
  });

  it('useI18n hook switches languages and persists', () => {
    const { result } = renderHook(() => useI18n(), {
      wrapper: TerminalProvider,
    });

    act(() => {
      result.current.setLanguage('en');
    });
    expect(result.current.language).toBe('en');
    expect(result.current.t('common.admin')).toBe('Admin');

    act(() => {
      result.current.setLanguage('zh');
    });

    expect(result.current.language).toBe('zh');
    expect(result.current.t('common.admin')).toBe('管理面板');
  });

  it('ensures key parity between English and Chinese dictionary structure', () => {
    const checkKeys = (enObj: Record<string, any>, zhObj: Record<string, any>, path = '') => {
      for (const key of Object.keys(enObj)) {
        const fullPath = path ? `${path}.${key}` : key;
        expect(zhObj[key], `Missing key in zh dictionary: ${fullPath}`).toBeDefined();

        if (typeof enObj[key] === 'object' && enObj[key] !== null) {
          expect(typeof zhObj[key]).toBe('object');
          checkKeys(enObj[key], zhObj[key], fullPath);
        }
      }
    };

    checkKeys(en, zh);
  });

  it('describes connection status in English and Chinese', () => {
    const tZh = (key: string) => translate('zh', key as any);
    const tEn = (key: string) => translate('en', key as any);

    // Connected
    expect(describeConnection('connected', tEn).label).toBe('Live');
    expect(describeConnection('connected', tZh).label).toBe('在线 (Live)');

    // Reconnecting
    const reconEn = describeConnection('reconnecting', tEn);
    expect(reconEn.label).toBe('Reconnecting');
    expect(reconEn.actionLabel).toBe('Reconnect now');

    const reconZh = describeConnection('reconnecting', tZh);
    expect(reconZh.label).toBe('正在重连');
    expect(reconZh.actionLabel).toBe('立即重连');

    // Error
    const errZh = describeConnection('error', tZh);
    expect(errZh.label).toBe('连接错误');
    expect(errZh.actionLabel).toBe('重试');

    // Offline / Disconnected
    const offZh = describeConnection('disconnected', tZh);
    expect(offZh.label).toBe('离线');
    expect(offZh.actionLabel).toBe('发起连接');
  });

  it('renders MobileControlSheet localized in Chinese and English', () => {
    // 1. Render in Chinese
    saveSettings({ language: 'zh' });
    const { unmount } = render(
      <TerminalProvider>
        <MobileControlSheet
          onClose={() => {}}
          onNavigateAdmin={() => {}}
          onOpenPairing={() => {}}
          onOpenSettings={() => {}}
        />
      </TerminalProvider>
    );

    expect(screen.getByText('会话控制')).toBeInTheDocument();
    expect(screen.getByText('输入控制权')).toBeInTheDocument();
    expect(screen.getByText('设置')).toBeInTheDocument();
    expect(screen.getByText('管理面板')).toBeInTheDocument();
    expect(screen.getByText('配对')).toBeInTheDocument();
    expect(screen.getByText('虚拟按键条')).toBeInTheDocument();
    expect(screen.getByLabelText('关闭会话控制面板')).toBeInTheDocument();

    unmount();

    // 2. Render in English
    saveSettings({ language: 'en' });
    render(
      <TerminalProvider>
        <MobileControlSheet
          onClose={() => {}}
          onNavigateAdmin={() => {}}
          onOpenPairing={() => {}}
          onOpenSettings={() => {}}
        />
      </TerminalProvider>
    );

    expect(screen.getByText('Session controls')).toBeInTheDocument();
    expect(screen.getByText('Input control')).toBeInTheDocument();
    expect(screen.getByText('Settings')).toBeInTheDocument();
    expect(screen.getByText('Admin')).toBeInTheDocument();
    expect(screen.getByText('Pairing')).toBeInTheDocument();
    expect(screen.getByText('Key bar')).toBeInTheDocument();
    expect(screen.getByLabelText('Close session controls')).toBeInTheDocument();
  });

  it('renders admin tables empty states and role badges localized in Chinese and English', () => {
    // 1. Chinese Admin Tables
    saveSettings({ language: 'zh' });
    const { unmount } = render(
      <TerminalProvider>
        <ClientsTable clients={[]} />
        <PtysTable ptys={[]} />
      </TerminalProvider>
    );

    expect(screen.getByText('当前暂无客户端连接')).toBeInTheDocument();
    expect(screen.getByText('当前无活跃的 PTY 会话')).toBeInTheDocument();

    unmount();

    // 2. English Admin Tables with clients
    saveSettings({ language: 'en' });
    const { unmount: unmount2 } = render(
      <TerminalProvider>
        <ClientsTable
          clients={[
            { id: 'client-1', role: 'controller', connectedAt: new Date().toISOString() },
            { id: 'client-2', role: 'viewer', connectedAt: new Date().toISOString() },
          ]}
        />
        <PtysTable ptys={[]} />
      </TerminalProvider>
    );

    expect(screen.getByText('No active PTY sessions allocated')).toBeInTheDocument();
    expect(screen.getByText('Controller')).toBeInTheDocument();
    expect(screen.getByText('Viewer')).toBeInTheDocument();
    expect(screen.getByText('Client ID')).toBeInTheDocument();
    expect(screen.getByText('Role')).toBeInTheDocument();

    unmount2();

    // 3. Chinese Admin Tables with clients
    saveSettings({ language: 'zh' });
    render(
      <TerminalProvider>
        <ClientsTable
          clients={[
            { id: 'client-1', role: 'controller', connectedAt: new Date().toISOString() },
            { id: 'client-2', role: 'viewer', connectedAt: new Date().toISOString() },
          ]}
        />
      </TerminalProvider>
    );

    expect(screen.getByText('控制端')).toBeInTheDocument();
    expect(screen.getByText('观察者')).toBeInTheDocument();
    expect(screen.getByText('客户端标识 (ID)')).toBeInTheDocument();
    expect(screen.getByText('角色权限')).toBeInTheDocument();
  });

  it('renders TerminalView with localized welcome banner in terminal buffer', () => {
    saveSettings({ language: 'zh' });
    render(
      <TerminalProvider>
        <TerminalView />
      </TerminalProvider>
    );

    const xtermInstances = (globalThis as unknown as { __xtermInstances: any[] }).__xtermInstances;
    const term = xtermInstances[xtermInstances.length - 1];
    expect(term).toBeDefined();

    const writtenText = (term.writes || []).join('\n');
    expect(writtenText).toContain('Herdr Remote WebUI');
    expect(writtenText).toContain('已连接至 Herdr 代理多路复用会话。');
  });

  it('localizes all virtual key titles across Chinese and English and falls back for unknown keys', () => {
    const tZh = (key: string) => translate('zh', key as any);
    const tEn = (key: string) => translate('en', key as any);

    // 1. Check all preset keys in ALL_AVAILABLE_KEYS have translations
    for (const keyDef of ALL_AVAILABLE_KEYS) {
      const enTitle = getLocalizedKeyTitle(keyDef, tEn);
      const zhTitle = getLocalizedKeyTitle(keyDef, tZh);

      expect(enTitle).toBeTruthy();
      expect(zhTitle).toBeTruthy();
      expect(enTitle).not.toBe(`keyTitles.${keyDef.id}`);
      expect(zhTitle).not.toBe(`keyTitles.${keyDef.id}`);
    }

    // 2. Specific key assertions
    expect(getLocalizedKeyTitle({ id: 'esc', label: 'ESC' }, tZh)).toBe('Escape (ESC 键)');
    expect(getLocalizedKeyTitle({ id: 'enter', label: 'Enter' }, tZh)).toBe('回车键 (Enter)');
    expect(getLocalizedKeyTitle({ id: 'ctrl_c', label: '^C' }, tZh)).toBe('Ctrl+C (中断/SIGINT)');
    expect(getLocalizedKeyTitle({ id: 'sym_pipe', label: '|' }, tZh)).toBe('竖线管道符 (|)');
    expect(getLocalizedKeyTitle({ id: 'f1', label: 'F1' }, tZh)).toBe('功能键 F1');

    // 3. Fallback for unknown / custom user key
    const customKey = { id: 'custom_my_key', label: 'CustomKey', title: 'My Custom Action' };
    expect(getLocalizedKeyTitle(customKey, tZh)).toBe('My Custom Action');
    expect(getLocalizedKeyTitle({ id: 'custom_bare', label: 'Foo' }, tZh)).toBe('Foo');
  });

  it('renders KeyToolbar and SettingsModal with localized key titles', () => {
    // 1. KeyToolbar in Chinese
    saveSettings({ language: 'zh' });
    const { unmount } = render(
      <TerminalProvider>
        <KeyToolbar />
      </TerminalProvider>
    );

    expect(screen.getByTitle('Escape (ESC 键)')).toBeInTheDocument();
    expect(screen.getByTitle('回车键 (Enter)')).toBeInTheDocument();
    expect(screen.getByTitle('切换 Ctrl 组合键锁定')).toBeInTheDocument();

    unmount();

    // 2. SettingsModal in Chinese
    render(
      <TerminalProvider>
        <SettingsModal isOpen={true} onClose={() => {}} />
      </TerminalProvider>
    );

    fireEvent.click(screen.getByText('虚拟按键'));

    expect(screen.getByText('Escape (ESC 键)')).toBeInTheDocument();
    expect(screen.getByText('回车键 (Enter)')).toBeInTheDocument();
    expect(screen.getByText('切换 Ctrl 组合键锁定')).toBeInTheDocument();
  });

  it('verifies all Header keys and tooltips resolve correctly without returning key paths', () => {
    const headerKeys = [
      'header.appName',
      'header.terminalTab',
      'header.adminTab',
      'header.hostLabel',
      'header.clientIdLabel',
      'header.copyClientIdTitle',
      'header.languageToggleTitle',
      'header.pairingTitle',
      'header.settingsTitle',
      'header.virtualKeyboardTitle',
      'header.latencyTitle',
      'header.mainNavigationAria',
    ];

    for (const key of headerKeys) {
      const enVal = translate('en', key as any);
      const zhVal = translate('zh', key as any);

      expect(enVal, `Key ${key} in en must not return key path`).not.toBe(key);
      expect(zhVal, `Key ${key} in zh must not return key path`).not.toBe(key);
      expect(enVal.length).toBeGreaterThan(0);
      expect(zhVal.length).toBeGreaterThan(0);
    }

    // Render Header in Chinese and ensure all button tooltips and labels are translated
    saveSettings({ language: 'zh' });
    const { unmount } = render(
      <TerminalProvider>
        <Header
          currentView="terminal"
          onNavigate={() => {}}
          onOpenPairing={() => {}}
          onOpenSettings={() => {}}
          onToggleVirtualKeyboard={() => {}}
          isVirtualKeyboardOpen={false}
        />
      </TerminalProvider>
    );

    expect(screen.getByTitle('切换界面语言 (English / 中文)')).toBeInTheDocument();
    expect(screen.getByTitle('连接与配对设置')).toBeInTheDocument();
    expect(screen.getByTitle('终端首选项')).toBeInTheDocument();
    expect(screen.getByTitle('快捷文本命令助手')).toBeInTheDocument();

    unmount();

    // Render Header in English
    saveSettings({ language: 'en' });
    render(
      <TerminalProvider>
        <Header
          currentView="terminal"
          onNavigate={() => {}}
          onOpenPairing={() => {}}
          onOpenSettings={() => {}}
          onToggleVirtualKeyboard={() => {}}
          isVirtualKeyboardOpen={false}
        />
      </TerminalProvider>
    );

    expect(screen.getByTitle('Switch interface language (EN / 中文)')).toBeInTheDocument();
    expect(screen.getByTitle('Connection & pairing settings')).toBeInTheDocument();
    expect(screen.getByTitle('Terminal preferences')).toBeInTheDocument();
    expect(screen.getByTitle('Quick command helper')).toBeInTheDocument();
  });

  it('statically scans all web source files to ensure every static t(...) key resolves in en and zh', () => {
    const srcDir = path.resolve(__dirname, '..');
    const getFiles = (dir: string): string[] => {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      const files: string[] = [];
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== 'test' && entry.name !== 'node_modules') {
            files.push(...getFiles(fullPath));
          }
        } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) {
          if (!entry.name.endsWith('.d.ts')) {
            files.push(fullPath);
          }
        }
      }
      return files;
    };

    const sourceFiles = getFiles(srcDir);
    const keyRegex = /\b(?:t|tRef\.current|translate)\(\s*(?:lang|nextLang)?\s*,?\s*['"]([a-zA-Z0-9_]+\.[a-zA-Z0-9_.]+)['"]/g;
    const foundKeys = new Set<string>();

    for (const file of sourceFiles) {
      const content = fs.readFileSync(file, 'utf-8');
      let match: RegExpExecArray | null;
      while ((match = keyRegex.exec(content)) !== null) {
        foundKeys.add(match[1]);
      }
    }

    expect(foundKeys.size).toBeGreaterThan(50);

    for (const key of foundKeys) {
      const enVal = translate('en', key as any);
      const zhVal = translate('zh', key as any);

      expect(enVal, `Source key "${key}" in en must not return fallback path`).not.toBe(key);
      expect(zhVal, `Source key "${key}" in zh must not return fallback path`).not.toBe(key);
      expect(enVal.length).toBeGreaterThan(0);
      expect(zhVal.length).toBeGreaterThan(0);
    }
  });

  it('verifies localized themes and font preset titles in en and zh', () => {
    const themeIds = ['claude', 'light', 'dark', 'tokyonight', 'monokai', 'matrix'] as const;
    for (const id of themeIds) {
      const enTheme = translate('en', `themes.${id}` as any);
      const zhTheme = translate('zh', `themes.${id}` as any);

      expect(enTheme).toBeTruthy();
      expect(zhTheme).toBeTruthy();
      expect(enTheme).not.toBe(`themes.${id}`);
      expect(zhTheme).not.toBe(`themes.${id}`);
    }

    const presetIds = ['system', 'apple', 'windows', 'linux', 'courier', 'firacode'] as const;
    for (const id of presetIds) {
      const enPreset = translate('en', `fontPresets.${id}` as any);
      const zhPreset = translate('zh', `fontPresets.${id}` as any);

      expect(enPreset).toBeTruthy();
      expect(zhPreset).toBeTruthy();
      expect(enPreset).not.toBe(`fontPresets.${id}`);
      expect(zhPreset).not.toBe(`fontPresets.${id}`);
    }

    // Render SettingsModal in Chinese and check localized theme/font preset rendering
    saveSettings({ language: 'zh' });
    render(
      <TerminalProvider>
        <SettingsModal isOpen={true} onClose={() => {}} />
      </TerminalProvider>
    );

    expect(screen.getByText('Claude 象牙暖白 (Claude Ivory)')).toBeInTheDocument();
    expect(screen.getByText('纯白极简 (Pure White)')).toBeInTheDocument();
    expect(screen.getByText('Herdr 午夜蓝 (Herdr Midnight)')).toBeInTheDocument();
    expect(screen.getByText('系统默认 (推荐 / System Default)')).toBeInTheDocument();
    expect(screen.getByText('Fira Code (连字特性 / Ligatures)')).toBeInTheDocument();
  });
});
