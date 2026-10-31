// The five context objects TerminalProvider fills, and the hooks that read
// them. Contexts live here rather than in TerminalContext so both the provider
// and the hooks can share them without a cycle.

import { type Context, createContext, useContext } from 'react';
import type {
  ConnectionContextValue,
  SettingsContextValue,
  TerminalContextValue,
  TerminalIOContextValue,
  ToastContextValue,
  UploadContextValue,
} from './values';

export const SettingsContext = createContext<SettingsContextValue | null>(null);
export const ConnectionContext = createContext<ConnectionContextValue | null>(null);
export const ToastContext = createContext<ToastContextValue | null>(null);
export const TerminalIOContext = createContext<TerminalIOContextValue | null>(null);
export const UploadContext = createContext<UploadContextValue | null>(null);

function useRequired<T>(context: Context<T | null>, hook: string): T {
  const value = useContext(context);
  if (!value) {
    throw new Error(`${hook} must be used within a TerminalProvider`);
  }
  return value;
}

/** Settings, translations, connection profiles and the terminal font. */
export const useSettings = () => useRequired(SettingsContext, 'useSettings');
/** The relay session: its state, the host, and controlling the connection. */
export const useConnection = () => useRequired(ConnectionContext, 'useConnection');
export const useToasts = () => useRequired(ToastContext, 'useToasts');
/** Sending into the terminal, and receiving its output. */
export const useTerminalIO = () => useRequired(TerminalIOContext, 'useTerminalIO');
export const useUpload = () => useRequired(UploadContext, 'useUpload');

/**
 * Everything at once. Prefer the narrower hooks above: a component using this
 * re-renders on every change to any of them.
 */
export function useTerminal(): TerminalContextValue {
  return {
    ...useSettings(),
    ...useConnection(),
    ...useToasts(),
    ...useTerminalIO(),
    ...useUpload(),
  };
}
