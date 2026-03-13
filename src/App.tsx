import React, { useState, useEffect, useRef } from "react";
import {
  Smartphone,
  Link as LinkIcon,
  Clock3,
  Braces,
  ChevronDown,
  ChevronRight,
  Maximize2,
  WrapText,
  Play,
  Copy,
  Trash2,
  GripVertical,
  X,
  Plus,
  Bot,
  ArrowLeft,
  RotateCcw,
  RefreshCw,
  Settings,
} from "lucide-react";
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  DragEndEvent,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
  rectSortingStrategy, // <--- 使用支持多行网格/换行的拖拽算法
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { invoke } from "@tauri-apps/api/core";
import { enable as enableAutostart, disable as disableAutostart, isEnabled as isAutostartEnabled } from "@tauri-apps/plugin-autostart";
import AgentLauncher from "./components/AgentLauncher";

// =======================
// 配置区：工具注册表
// =======================
const INITIAL_TOOLS = [
  { id: "agent-launcher", name: "Agent 启动", icon: Bot, singleton: true },
  { id: "adb", name: "ADB WiFi 配对", icon: Smartphone, singleton: true },
  { id: "url-encode", name: "URL 编解码", icon: LinkIcon },
  { id: "json-formatter", name: "JSON 格式化", icon: Braces },
  { id: "unix-timestamp", name: "Unix 时间戳", icon: Clock3 },
];

const generateInstanceId = () => `inst_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

interface ToolInstance {
  instanceId: string;
  toolId: string;
  title: string;
}

interface AdbCommandResult {
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  success: boolean;
}

interface AdbDevice {
  serial: string;
  status: string;
}

interface AdbDevicesResult extends AdbCommandResult {
  devices: AdbDevice[];
}

type TimestampUnit = "seconds" | "milliseconds";

type ConsoleLineType = "info" | "command" | "success" | "error";

interface ConsoleLine {
  id: string;
  text: string;
  type: ConsoleLineType;
}

type AdbFlowStep = "checking" | "existing-devices" | "pair" | "connect" | "done";

type IpOctets = [string, string, string, string];

type ThemeMode = "light" | "dark" | "system";
type JsonResultTab = "formatted" | "tree";
type JsonValidationState = "idle" | "valid" | "invalid" | "text";
type JsonStatusSource = "validation" | "action";

type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

interface JsonValidationExcerptLine {
  lineNumber: number;
  text: string;
  isTarget: boolean;
}

interface JsonValidationInfo {
  message: string;
  line: number | null;
  column: number | null;
  position: number | null;
  excerptLines: JsonValidationExcerptLine[];
}

interface SegmentedAddressValue {
  octets: IpOctets;
  port: string;
}

const MAX_PAIRING_CODE_DIGITS = 6;
const PAIR_ADDRESS_STORAGE_KEY = "adb_last_pair_address";
const CONNECT_ADDRESS_STORAGE_KEY = "adb_last_connect_address";
const THEME_STORAGE_KEY = "app_theme_mode";
const GLOBAL_SHORTCUT_STORAGE_KEY = "app_global_shortcut";
const THEME_OPTIONS: Array<{ id: ThemeMode; label: string }> = [
  { id: "light", label: "浅色" },
  { id: "dark", label: "深色" },
  { id: "system", label: "跟随系统" },
];

const GLOBAL_SHORTCUT_MODIFIER_KEYS = new Set(["Control", "Shift", "Alt", "Meta"]);

const mapGlobalShortcutKey = (key: string) => {
  if (GLOBAL_SHORTCUT_MODIFIER_KEYS.has(key)) {
    return null;
  }

  if (key === " ") {
    return "Space";
  }

  if (key.length === 1) {
    const upperKey = key.toUpperCase();
    if (/^[A-Z0-9]$/.test(upperKey)) {
      return upperKey;
    }

    if (key === ",") return "Comma";
    if (key === ".") return "Period";
    if (key === "+") return "Plus";
    if (key === "-") return "Minus";
  }

  const aliasMap: Record<string, string> = {
    ArrowUp: "Up",
    ArrowDown: "Down",
    ArrowLeft: "Left",
    ArrowRight: "Right",
    Escape: "Esc",
    Enter: "Enter",
    Tab: "Tab",
    Backspace: "Backspace",
    Delete: "Delete",
    Insert: "Insert",
    Home: "Home",
    End: "End",
    PageUp: "PageUp",
    PageDown: "PageDown",
  };

  if (aliasMap[key]) {
    return aliasMap[key];
  }

  if (/^F\d{1,2}$/i.test(key)) {
    return key.toUpperCase();
  }

  return null;
};

const formatGlobalShortcut = (event: React.KeyboardEvent<HTMLInputElement>) => {
  const parts: string[] = [];

  if (event.ctrlKey) parts.push("Ctrl");
  if (event.altKey) parts.push("Alt");
  if (event.shiftKey) parts.push("Shift");
  if (event.metaKey) parts.push(navigator.userAgent.includes("Mac") ? "Command" : "Meta");

  const mainKey = mapGlobalShortcutKey(event.key);
  if (!mainKey) {
    return null;
  }

  parts.push(mainKey);
  return parts.join("+");
};

const getInitialThemeMode = (): ThemeMode => {
  const stored = localStorage.getItem(THEME_STORAGE_KEY);
  if (stored === "light" || stored === "dark" || stored === "system") {
    return stored;
  }
  return "system";
};

const getInitialGlobalShortcut = () => localStorage.getItem(GLOBAL_SHORTCUT_STORAGE_KEY) ?? "";

const createConsoleLine = (text: string, type: ConsoleLineType): ConsoleLine => ({
  id: `log_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
  text,
  type,
});

const createEmptyAddress = (): SegmentedAddressValue => ({
  octets: ["", "", "", ""],
  port: "",
});

const parseStoredAddress = (storageKey: string): SegmentedAddressValue => {
  const raw = localStorage.getItem(storageKey) ?? "";
  const ipOnlyMatch = raw.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  const ipWithPortMatch = raw.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3}):(\d{1,5})$/);

  if (ipOnlyMatch) {
    return {
      octets: [ipOnlyMatch[1], ipOnlyMatch[2], ipOnlyMatch[3], ipOnlyMatch[4]],
      port: "",
    };
  }

  if (ipWithPortMatch) {
    return {
      octets: [ipWithPortMatch[1], ipWithPortMatch[2], ipWithPortMatch[3], ipWithPortMatch[4]],
      port: "",
    };
  }

  return createEmptyAddress();
};

const serializeAddress = (value: SegmentedAddressValue) =>
  `${value.octets[0]}.${value.octets[1]}.${value.octets[2]}.${value.octets[3]}:${value.port}`;

const serializeStoredIp = (value: SegmentedAddressValue) =>
  `${value.octets[0]}.${value.octets[1]}.${value.octets[2]}.${value.octets[3]}`;

const hasAnyStoredIpValue = (value: SegmentedAddressValue) =>
  value.octets.some((octet) => octet.length > 0);

const padTimeValue = (value: number) => value.toString().padStart(2, "0");

const isJsonContainer = (value: JsonValue): value is JsonValue[] | { [key: string]: JsonValue } =>
  Array.isArray(value) || (typeof value === "object" && value !== null);

const toJsonValue = (value: unknown): JsonValue => {
  if (
    value === null
    || typeof value === "string"
    || typeof value === "number"
    || typeof value === "boolean"
  ) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => toJsonValue(item));
  }

  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, nestedValue]) => [key, toJsonValue(nestedValue)])
    );
  }

  throw new Error("仅支持标准 JSON 内容。");
};

const decodeEscapedJsonText = (input: string) => {
  const trimmed = input.trim();
  if (!trimmed) {
    return trimmed;
  }

  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed === "string") {
      return parsed;
    }
  } catch {
    // 忽略，继续尝试常见转义文本场景
  }

  const unicodeDecoded = trimmed.replace(/\\u([0-9a-fA-F]{4})/g, (_, code: string) =>
    String.fromCharCode(parseInt(code, 16))
  );

  const normalized = unicodeDecoded
    .replace(/\\"/g, "\"")
    .replace(/\\\//g, "/")
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t")
    .replace(/\\\\/g, "\\");

  if (
    (normalized.startsWith("\"") && normalized.endsWith("\""))
    || (normalized.startsWith("'") && normalized.endsWith("'"))
  ) {
    return normalized.slice(1, -1);
  }

  return normalized;
};

const parseJsonInput = (input: string, removeEscapes = false) => {
  const sourceText = removeEscapes ? decodeEscapedJsonText(input) : input.trim();

  if (!sourceText.trim()) {
    throw new Error("请输入 JSON 内容后再执行。");
  }

  const parsed = toJsonValue(JSON.parse(sourceText));

  return {
    normalizedInput: sourceText,
    parsed,
    formatted: JSON.stringify(parsed, null, 2),
  };
};

const collectExpandableJsonPaths = (
  value: JsonValue,
  segments: Array<string | number> = ["$"]
): string[] => {
  if (!isJsonContainer(value)) {
    return [];
  }

  const currentPath = JSON.stringify(segments);
  const childPaths = Array.isArray(value)
    ? value.flatMap((item, index) => collectExpandableJsonPaths(item, [...segments, index]))
    : Object.entries(value).flatMap(([key, nestedValue]) =>
      collectExpandableJsonPaths(nestedValue, [...segments, key])
    );

  return [currentPath, ...childPaths];
};

const appendJsonPath = (path: string, segment: string | number) => {
  const segments = JSON.parse(path) as Array<string | number>;
  return JSON.stringify([...segments, segment]);
};

const getLineColumnFromPosition = (source: string, position: number) => {
  const safePosition = Math.max(0, Math.min(position, source.length));
  const prefix = source.slice(0, safePosition);
  const line = prefix.split(/\r?\n/).length;
  const lastLineBreakIndex = Math.max(prefix.lastIndexOf("\n"), prefix.lastIndexOf("\r"));
  const column = safePosition - lastLineBreakIndex;

  return { line, column };
};

const buildJsonValidationInfo = (source: string, error: unknown): JsonValidationInfo => {
  const message = error instanceof Error ? error.message : String(error);
  let line: number | null = null;
  let column: number | null = null;
  let position: number | null = null;

  const lineColumnMatch = message.match(/line\s+(\d+)\s+column\s+(\d+)/i);
  if (lineColumnMatch) {
    line = Number(lineColumnMatch[1]);
    column = Number(lineColumnMatch[2]);
  }

  const positionMatch = message.match(/position\s+(\d+)/i);
  if (positionMatch) {
    position = Number(positionMatch[1]);
  }

  if (position !== null && (line === null || column === null)) {
    const resolved = getLineColumnFromPosition(source, position);
    line = resolved.line;
    column = resolved.column;
  }

  const lines = source.split(/\r?\n/);
  const targetLine = line ?? 1;
  const startLine = Math.max(1, targetLine - 1);
  const endLine = Math.min(lines.length, targetLine + 1);

  return {
    message,
    line,
    column,
    position,
    excerptLines: lines.length === 0
      ? []
      : lines.slice(startLine - 1, endLine).map((text, index) => ({
        lineNumber: startLine + index,
        text,
        isTarget: startLine + index === targetLine,
      })),
  };
};

const getJsonContainerSummary = (value: JsonValue[] | { [key: string]: JsonValue }) =>
  Array.isArray(value) ? `Array(${value.length})` : `Object(${Object.keys(value).length})`;

const formatJsonLeafValue = (value: Exclude<JsonValue, JsonValue[] | { [key: string]: JsonValue }>) => {
  if (typeof value === "string") {
    return `"${value}"`;
  }

  if (value === null) {
    return "null";
  }

  return String(value);
};

const escapeJsonText = (input: string) => {
  if (!input.trim()) {
    throw new Error("请输入内容后再增加转义。");
  }

  return JSON.stringify(input).slice(1, -1);
};

const formatDateTime = (date: Date) =>
  `${date.getFullYear()}-${padTimeValue(date.getMonth() + 1)}-${padTimeValue(date.getDate())} ${padTimeValue(date.getHours())}:${padTimeValue(date.getMinutes())}:${padTimeValue(date.getSeconds())}`;

const parseDateTimeInput = (value: string) => {
  const trimmed = value.trim();
  const match = trimmed.match(
    /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})\s+(\d{1,2}):(\d{1,2}):(\d{1,2})$/
  );

  if (!match) {
    return null;
  }

  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);

  const parsed = new Date(year, month - 1, day, hour, minute, second);

  if (
    parsed.getFullYear() !== year
    || parsed.getMonth() !== month - 1
    || parsed.getDate() !== day
    || parsed.getHours() !== hour
    || parsed.getMinutes() !== minute
    || parsed.getSeconds() !== second
  ) {
    return null;
  }

  return parsed;
};

const convertDateToTimestamp = (date: Date, unit: TimestampUnit) =>
  unit === "seconds" ? Math.floor(date.getTime() / 1000) : date.getTime();

const getAddressValidationMessage = (value: SegmentedAddressValue, label: string) => {
  if (value.octets.some((octet) => octet.length === 0) || value.port.length === 0) {
    return `请输入完整的${label}，格式如 192.168.1.100:37000。`;
  }

  const octets = value.octets.map(Number);
  if (octets.some((octet) => octet < 0 || octet > 255)) {
    return `${label}中的 IP 段必须在 0-255 之间。`;
  }

  const port = Number(value.port);
  if (port < 1 || port > 65535) {
    return `${label}中的端口必须在 1-65535 之间。`;
  }

  return null;
};

function SegmentedAddressInput({
  label,
  value,
  onChange,
  disabled,
  tone,
}: {
  label: string;
  value: SegmentedAddressValue;
  onChange: (value: SegmentedAddressValue) => void;
  disabled?: boolean;
  tone: "blue" | "emerald";
}) {
  const inputRefs = useRef<Array<HTMLInputElement | null>>([]);
  const focusRingClass =
    tone === "emerald"
      ? "focus:ring-emerald-500/20 focus:border-emerald-500"
      : "focus:ring-blue-500/20 focus:border-blue-500";

  const updateSegment = (index: number, nextRawValue: string) => {
    const maxLength = index < 4 ? 3 : 5;
    const digitsOnly = nextRawValue.replace(/\D/g, "").slice(0, maxLength);
    const nextValue: SegmentedAddressValue = {
      octets: [...value.octets] as IpOctets,
      port: value.port,
    };

    if (index < 4) {
      nextValue.octets[index] = digitsOnly;
    } else {
      nextValue.port = digitsOnly;
    }

    onChange(nextValue);

    if (digitsOnly.length === maxLength && index < 4) {
      inputRefs.current[index + 1]?.focus();
      inputRefs.current[index + 1]?.select();
    }
  };

  const handleKeyDown = (index: number, currentValue: string, event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Backspace" && currentValue.length === 0 && index > 0) {
      inputRefs.current[index - 1]?.focus();
      inputRefs.current[index - 1]?.select();
    }
  };

  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-2">{label}</label>
      <div className="flex items-center gap-2">
        {value.octets.map((octet, index) => (
          <React.Fragment key={`${label}_octet_${index}`}>
            <input
              ref={(node) => {
                inputRefs.current[index] = node;
              }}
              type="text"
              inputMode="numeric"
              value={octet}
              onChange={(e) => updateSegment(index, e.target.value)}
              onKeyDown={(e) => handleKeyDown(index, octet, e)}
              className={`w-14 px-3 py-2.5 text-center bg-gray-50 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 transition-all ${focusRingClass}`}
              disabled={disabled}
              maxLength={3}
              aria-label={`${label}第 ${index + 1} 段`}
            />
            {index < 3 && <span className="text-gray-400 text-lg font-medium">.</span>}
          </React.Fragment>
        ))}
        <span className="text-gray-400 text-lg font-medium">:</span>
        <input
          ref={(node) => {
            inputRefs.current[4] = node;
          }}
          type="text"
          inputMode="numeric"
          value={value.port}
          onChange={(e) => updateSegment(4, e.target.value)}
          onKeyDown={(e) => handleKeyDown(4, value.port, e)}
          className={`w-24 px-3 py-2.5 text-center bg-gray-50 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 transition-all ${focusRingClass}`}
          disabled={disabled}
          maxLength={5}
          aria-label={`${label}端口`}
        />
      </div>
      <p className="mt-2 text-xs text-gray-400">每个网段单独输入；输入满 3 位会自动跳到下一个框。</p>
    </div>
  );
}

function PairingCodeInput({
  value,
  onChange,
  disabled,
}: {
  value: string[];
  onChange: (value: string[]) => void;
  disabled?: boolean;
}) {
  const inputRefs = useRef<Array<HTMLInputElement | null>>([]);

  const updateDigits = (index: number, rawValue: string) => {
    const digits = rawValue.replace(/\D/g, "");
    const nextValue = [...value];

    if (digits.length === 0) {
      nextValue[index] = "";
      onChange(nextValue);
      return;
    }

    digits
      .slice(0, MAX_PAIRING_CODE_DIGITS - index)
      .split("")
      .forEach((digit, offset) => {
        nextValue[index + offset] = digit;
      });

    onChange(nextValue);

    const nextIndex = Math.min(index + digits.length, MAX_PAIRING_CODE_DIGITS - 1);
    inputRefs.current[nextIndex]?.focus();
    inputRefs.current[nextIndex]?.select();
  };

  const handleKeyDown = (index: number, event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Backspace") return;

    if (value[index]) {
      const nextValue = [...value];
      nextValue[index] = "";
      onChange(nextValue);
      return;
    }

    if (index > 0) {
      const nextValue = [...value];
      nextValue[index - 1] = "";
      onChange(nextValue);
      inputRefs.current[index - 1]?.focus();
      inputRefs.current[index - 1]?.select();
      event.preventDefault();
    }
  };

  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-2">配对码</label>
      <div className="flex items-center gap-2">
        {value.map((digit, index) => (
          <input
            key={`pairing_code_${index}`}
            ref={(node) => {
              inputRefs.current[index] = node;
            }}
            type="text"
            inputMode="numeric"
            value={digit}
            onChange={(e) => updateDigits(index, e.target.value)}
            onKeyDown={(e) => handleKeyDown(index, e)}
            className="w-11 px-0 py-2.5 text-center bg-gray-50 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all"
            disabled={disabled}
            maxLength={1}
            aria-label={`配对码第 ${index + 1} 位`}
          />
        ))}
      </div>
      <p className="mt-2 text-xs text-gray-400">固定 6 位，每输入一位会自动跳到下一格。</p>
    </div>
  );
}

// =======================
// 独立工具组件
// =======================
function AdbTool() {
  const [step, setStep] = useState<AdbFlowStep>("pair");
  const [pairAddress, setPairAddress] = useState<SegmentedAddressValue>(() =>
    parseStoredAddress(PAIR_ADDRESS_STORAGE_KEY)
  );
  const [connectAddress, setConnectAddress] = useState<SegmentedAddressValue>(() =>
    parseStoredAddress(CONNECT_ADDRESS_STORAGE_KEY)
  );
  const [pairingCode, setPairingCode] = useState<string[]>(() =>
    Array.from({ length: MAX_PAIRING_CODE_DIGITS }, () => "")
  );
  const [existingDevices, setExistingDevices] = useState<AdbDevice[]>([]);
  const [checkError, setCheckError] = useState<string | null>(null);
  const [lastConnectedSerial, setLastConnectedSerial] = useState<string | null>(null);
  const [isCheckingDevices, setIsCheckingDevices] = useState(false);
  const [isPairing, setIsPairing] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [consoleLines, setConsoleLines] = useState<ConsoleLine[]>([
    createConsoleLine("> 等待执行指令...", "info"),
  ]);
  const consoleRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const panel = consoleRef.current;
    if (panel) {
      panel.scrollTop = panel.scrollHeight;
    }
  }, [consoleLines]);

  const appendConsoleLines = (entries: Array<{ text: string; type: ConsoleLineType }>) => {
    const normalized = entries
      .map((entry) => ({ ...entry, text: entry.text.trimEnd() }))
      .filter((entry) => entry.text.length > 0);

    if (normalized.length === 0) return;

    setConsoleLines((prev) => [
      ...prev,
      ...normalized.map((entry) => createConsoleLine(entry.text, entry.type)),
    ]);
  };

  const appendCommandResult = (result: AdbCommandResult) => {
    const nextLines: Array<{ text: string; type: ConsoleLineType }> = [
      { text: `$ ${result.command}`, type: "command" },
    ];

    if (result.stdout) {
      nextLines.push(
        ...result.stdout.split(/\r?\n/).map<{ text: string; type: ConsoleLineType }>((line) => ({
          text: line,
          type: result.success ? "success" : "info",
        }))
      );
    }

    if (result.stderr) {
      nextLines.push(
        ...result.stderr.split(/\r?\n/).map<{ text: string; type: ConsoleLineType }>((line) => ({
          text: line,
          type: "error",
        }))
      );
    }

    if (!result.stdout && !result.stderr) {
      nextLines.push({
        text: result.success ? "命令已执行完成。" : "命令执行失败，但未返回输出。",
        type: result.success ? "success" : "error",
      });
    }

    if (result.exitCode !== null) {
      nextLines.push({
        text: `exit code: ${result.exitCode}`,
        type: result.success ? "info" : "error",
      });
    }

    appendConsoleLines(nextLines);
  };

  const resetConsole = (message = "> 等待执行指令...") => {
    setConsoleLines([createConsoleLine(message, "info")]);
  };

  const checkDevices = async ({ resetLogs = false }: { resetLogs?: boolean } = {}) => {
    if (resetLogs) {
      resetConsole("> 正在检查当前 ADB 设备状态...");
    }

    setIsCheckingDevices(true);
    setCheckError(null);
    setStep("checking");

    try {
      const result = await invoke<AdbDevicesResult>("adb_list_devices");
      appendCommandResult(result);
      setExistingDevices(result.devices);

      if (result.devices.length > 0) {
        appendConsoleLines([
          {
            text: `检测到 ${result.devices.length} 台已连接设备，请确认是否继续新的连接流程。`,
            type: "info",
          },
        ]);
        setStep("existing-devices");
      } else {
        appendConsoleLines([{ text: "未检测到已连接设备，进入配对步骤。", type: "info" }]);
        setStep("pair");
      }
    } catch (error) {
      const message = `查询 adb devices 失败: ${String(error)}`;
      setCheckError(message);
      appendConsoleLines([{ text: message, type: "error" }]);
      alert(message);
    } finally {
      setIsCheckingDevices(false);
    }
  };

  useEffect(() => {
    if (hasAnyStoredIpValue(pairAddress)) {
      localStorage.setItem(PAIR_ADDRESS_STORAGE_KEY, serializeStoredIp(pairAddress));
    } else {
      localStorage.removeItem(PAIR_ADDRESS_STORAGE_KEY);
    }
  }, [pairAddress]);

  useEffect(() => {
    if (hasAnyStoredIpValue(connectAddress)) {
      localStorage.setItem(CONNECT_ADDRESS_STORAGE_KEY, serializeStoredIp(connectAddress));
    } else {
      localStorage.removeItem(CONNECT_ADDRESS_STORAGE_KEY);
    }
  }, [connectAddress]);

  const handleResetFlow = () => {
    setPairAddress(parseStoredAddress(PAIR_ADDRESS_STORAGE_KEY));
    setConnectAddress(parseStoredAddress(CONNECT_ADDRESS_STORAGE_KEY));
    setPairingCode(Array.from({ length: MAX_PAIRING_CODE_DIGITS }, () => ""));
    setExistingDevices([]);
    setCheckError(null);
    setLastConnectedSerial(null);
    resetConsole("> 流程已重置，重新检查当前 ADB 设备状态...");
    void checkDevices();
  };

  const handleBack = () => {
    if (isCheckingDevices || isPairing || isConnecting) return;

    if (step === "connect") {
      setStep("pair");
      return;
    }

    if (step === "done") {
      setStep("connect");
      return;
    }

    if (step === "pair") {
      if (existingDevices.length > 0) {
        setStep("existing-devices");
      } else {
        void checkDevices();
      }
    }
  };

  const handlePair = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const address = serializeAddress(pairAddress);
    const code = pairingCode.join("");

    const addressMessage = getAddressValidationMessage(pairAddress, "配对地址");
    if (addressMessage) {
      appendConsoleLines([{ text: addressMessage, type: "error" }]);
      alert(addressMessage);
      return;
    }

    if (code.length !== MAX_PAIRING_CODE_DIGITS) {
      const message = "配对码需为 6 位数字。";
      appendConsoleLines([{ text: message, type: "error" }]);
      alert(message);
      return;
    }

    setIsPairing(true);
    setLastConnectedSerial(null);

    try {
      const result = await invoke<AdbCommandResult>("adb_pair", {
        address,
        pairingCode: code,
      });

      appendCommandResult(result);

      if (result.success) {
        setConnectAddress({
          octets: [...pairAddress.octets] as IpOctets,
          port: "",
        });
        setStep("connect");
        appendConsoleLines([
          { text: "配对成功，已将 IP 带入第二步，请补充新的端口后执行 adb connect。", type: "success" },
        ]);
      }
    } catch (error) {
      appendConsoleLines([
        {
          text: `执行 adb pair 失败: ${String(error)}`,
          type: "error",
        },
      ]);
      alert(`执行 adb pair 失败: ${String(error)}`);
    } finally {
      setIsPairing(false);
    }
  };

  const handleConnect = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const address = serializeAddress(connectAddress);

    const addressMessage = getAddressValidationMessage(connectAddress, "连接地址");
    if (addressMessage) {
      const message = addressMessage;
      appendConsoleLines([{ text: message, type: "error" }]);
      alert(message);
      return;
    }

    setIsConnecting(true);
    setLastConnectedSerial(null);

    try {
      const result = await invoke<AdbCommandResult>("adb_connect", {
        address,
      });

      appendCommandResult(result);

      if (!result.success) {
        appendConsoleLines([
          { text: "adb connect 未返回成功结果，请检查设备状态后重试。", type: "error" },
        ]);
        return;
      }

      appendConsoleLines([{ text: "正在复核 adb devices 结果...", type: "info" }]);

      const verifyResult = await invoke<AdbDevicesResult>("adb_list_devices");
      appendCommandResult(verifyResult);
      setExistingDevices(verifyResult.devices);

      const isVerified = verifyResult.success
        && verifyResult.devices.some((device) => device.serial === address && device.status === "device");

      if (isVerified) {
        setLastConnectedSerial(address);
        setStep("done");
        appendConsoleLines([
          { text: "设备已在 adb devices 中确认上线，连接完成。", type: "success" },
        ]);
      } else {
        appendConsoleLines([
          { text: "未在 adb devices 中确认到目标设备，本次连接未通过验证。", type: "error" },
        ]);
      }
    } catch (error) {
      appendConsoleLines([
        {
          text: `执行 adb connect 失败: ${String(error)}`,
          type: "error",
        },
      ]);
      alert(`执行 adb connect 失败: ${String(error)}`);
    } finally {
      setIsConnecting(false);
    }
  };

  const handleClearConsole = () => {
    resetConsole("> 控制台已清空，等待执行指令...");
  };

  const canGoBack = step === "pair" || step === "connect" || step === "done";
  const showNavActions = step !== "pair";

  const renderStepPanel = () => {
    if (step === "checking") {
      return (
        <div className="bg-white p-6 rounded-2xl border border-gray-100 shadow-[0_2px_10px_-4px_rgba(0,0,0,0.05)]">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-10 h-10 rounded-xl bg-blue-50 flex items-center justify-center text-blue-500">
              <RefreshCw size={18} className={isCheckingDevices ? "animate-spin" : ""} />
            </div>
            <div>
              <h2 className="text-lg font-bold text-gray-900">检查当前设备</h2>
              <p className="text-sm text-gray-500 mt-0.5">开始前先执行 `adb devices`，确认是否已有设备在线</p>
            </div>
          </div>
          <div className="space-y-4">
            <div className="rounded-xl border border-gray-100 bg-gray-50 px-4 py-3 text-sm text-gray-600">
              {isCheckingDevices
                ? "正在查询当前 ADB 设备列表..."
                : checkError
                  ? checkError
                  : "设备检查已完成，正在进入下一步。"}
            </div>
            <button
              type="button"
              onClick={() => void checkDevices({ resetLogs: true })}
              disabled={isCheckingDevices}
              className="inline-flex items-center gap-2 px-4 py-2.5 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 text-white font-medium rounded-xl transition-all"
            >
              <RefreshCw size={16} className={isCheckingDevices ? "animate-spin" : ""} />
              重新检查
            </button>
          </div>
        </div>
      );
    }

    if (step === "existing-devices") {
      return (
        <div className="bg-white p-6 rounded-2xl border border-amber-100 shadow-[0_2px_10px_-4px_rgba(0,0,0,0.05)]">
          <div className="flex items-center gap-3 mb-5">
            <div className="w-10 h-10 rounded-xl bg-amber-50 flex items-center justify-center text-amber-500">
              <Smartphone size={18} />
            </div>
            <div>
              <h2 className="text-lg font-bold text-gray-900">检测到已连接设备</h2>
              <p className="text-sm text-gray-500 mt-0.5">若仍要建立新的无线连接，请确认后继续</p>
            </div>
          </div>
          <div className="space-y-3 mb-5">
            {existingDevices.map((device) => (
              <div
                key={`${device.serial}_${device.status}`}
                className="rounded-xl border border-gray-100 bg-gray-50 px-4 py-3"
              >
                <p className="text-sm font-medium text-gray-800 break-all">{device.serial}</p>
                <p className="text-xs text-gray-500 mt-1">状态：{device.status}</p>
              </div>
            ))}
          </div>
          <div className="flex flex-wrap gap-3">
            <button
              type="button"
              onClick={() => setStep("pair")}
              className="inline-flex items-center gap-2 px-4 py-2.5 bg-blue-600 hover:bg-blue-700 text-white font-medium rounded-xl transition-all"
            >
              <Play size={16} />
              继续新的连接流程
            </button>
            <button
              type="button"
              onClick={() => void checkDevices({ resetLogs: true })}
              className="inline-flex items-center gap-2 px-4 py-2.5 bg-white border border-gray-200 hover:bg-gray-50 text-gray-700 font-medium rounded-xl transition-all"
            >
              <RefreshCw size={16} />
              刷新设备列表
            </button>
          </div>
        </div>
      );
    }

    if (step === "pair") {
      return (
        <form
          onSubmit={handlePair}
          className="bg-white p-6 rounded-2xl border border-gray-100 shadow-[0_2px_10px_-4px_rgba(0,0,0,0.05)]"
        >
          <div className="flex items-center gap-3 mb-6">
            <div className="w-10 h-10 rounded-xl bg-blue-50 flex items-center justify-center text-blue-500">
              <Smartphone size={20} />
            </div>
            <div>
              <h2 className="text-lg font-bold text-gray-900">第一步：设备配对</h2>
              <p className="text-sm text-gray-500 mt-0.5">先输入配对地址和 6 位配对码执行 `adb pair`</p>
            </div>
          </div>
          <div className="space-y-5">
            <SegmentedAddressInput
              label="配对 IP:Port"
              value={pairAddress}
              onChange={setPairAddress}
              disabled={isPairing || isConnecting}
              tone="blue"
            />
            <PairingCodeInput value={pairingCode} onChange={setPairingCode} disabled={isPairing || isConnecting} />
            <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
              <button
                type="submit"
                disabled={isPairing || isConnecting}
                className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 disabled:cursor-not-allowed text-white font-medium rounded-xl transition-all shadow-sm shadow-blue-500/20 active:scale-[0.98]"
              >
                <Play size={16} />
                {isPairing ? "正在执行 adb pair..." : "执行 adb pair"}
              </button>
              <button
                type="button"
                onClick={() => void checkDevices({ resetLogs: true })}
                disabled={isCheckingDevices || isPairing || isConnecting}
                className="inline-flex items-center justify-center gap-2 px-4 py-3 bg-white border border-gray-200 hover:bg-gray-50 text-gray-700 font-medium rounded-xl transition-all disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <RefreshCw size={16} className={isCheckingDevices ? "animate-spin" : ""} />
                检查设备
              </button>
            </div>
          </div>
        </form>
      );
    }

    if (step === "connect") {
      return (
        <form
          onSubmit={handleConnect}
          className="bg-white p-6 rounded-2xl border border-emerald-100 shadow-[0_2px_10px_-4px_rgba(0,0,0,0.05)]"
        >
          <div className="flex items-center gap-3 mb-6">
            <div className="w-10 h-10 rounded-xl bg-emerald-50 flex items-center justify-center text-emerald-500">
              <Play size={18} />
            </div>
            <div>
              <h2 className="text-lg font-bold text-gray-900">第二步：连接设备</h2>
              <p className="text-sm text-gray-500 mt-0.5">配对成功后，再输入连接地址执行 `adb connect`</p>
            </div>
          </div>
          <div className="space-y-5">
            <SegmentedAddressInput
              label="连接 IP:Port"
              value={connectAddress}
              onChange={setConnectAddress}
              disabled={isPairing || isConnecting}
              tone="emerald"
            />
            <button
              type="submit"
              disabled={isPairing || isConnecting}
              className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-emerald-600 hover:bg-emerald-700 disabled:bg-emerald-400 disabled:cursor-not-allowed text-white font-medium rounded-xl transition-all shadow-sm shadow-emerald-500/20 active:scale-[0.98]"
            >
              <Play size={16} />
              {isConnecting ? "正在执行 adb connect..." : "执行 adb connect"}
            </button>
          </div>
        </form>
      );
    }

    return (
      <div className="bg-white p-6 rounded-2xl border border-emerald-100 shadow-[0_2px_10px_-4px_rgba(0,0,0,0.05)]">
        <div className="flex items-center gap-3 mb-5">
          <div className="w-10 h-10 rounded-xl bg-emerald-50 flex items-center justify-center text-emerald-500">
            <Play size={18} />
          </div>
          <div>
            <h2 className="text-lg font-bold text-gray-900">连接完成</h2>
            <p className="text-sm text-gray-500 mt-0.5">已通过 `adb devices` 复核连接结果</p>
          </div>
        </div>
        <div className="rounded-xl border border-emerald-100 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
          已确认设备 `{lastConnectedSerial ?? "未知设备"}` 在线，可继续调试。
        </div>
      </div>
    );
  };

  return (
    <div className="grid grid-cols-1 xl:grid-cols-2 gap-6 h-full">
      <div className="space-y-6">
        <div className="bg-white p-4 rounded-2xl border border-gray-100 shadow-[0_2px_10px_-4px_rgba(0,0,0,0.05)]">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-xs font-semibold tracking-wider text-gray-400 uppercase">ADB WiFi 向导</p>
              <p className="text-sm text-gray-500 mt-1">
                当前步骤：
                {step === "checking" && " 检查设备"}
                {step === "existing-devices" && " 已连接设备确认"}
                {step === "pair" && " 配对"}
                {step === "connect" && " 连接"}
                {step === "done" && " 完成"}
              </p>
            </div>
            {showNavActions && (
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={handleBack}
                  disabled={!canGoBack || isCheckingDevices || isPairing || isConnecting}
                  className="inline-flex items-center gap-2 px-3 py-2 text-sm bg-white border border-gray-200 hover:bg-gray-50 disabled:text-gray-300 disabled:border-gray-100 disabled:cursor-not-allowed text-gray-700 rounded-xl transition-all"
                >
                  <ArrowLeft size={14} />
                  返回上一步
                </button>
                <button
                  type="button"
                  onClick={handleResetFlow}
                  disabled={isCheckingDevices || isPairing || isConnecting}
                  className="inline-flex items-center gap-2 px-3 py-2 text-sm bg-white border border-gray-200 hover:bg-gray-50 disabled:text-gray-300 disabled:border-gray-100 disabled:cursor-not-allowed text-gray-700 rounded-xl transition-all"
                >
                  <RotateCcw size={14} />
                  重置流程
                </button>
              </div>
            )}
          </div>
        </div>

        {renderStepPanel()}
      </div>

      <div className="bg-[#1e1e1e] p-6 rounded-2xl shadow-sm flex flex-col h-full min-h-[400px]">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h3 className="text-sm font-bold text-gray-300 flex items-center gap-2">
              <div className="w-2 h-2 rounded-full bg-green-500"></div>
              控制台输出
            </h3>
            <p className="text-xs text-gray-500 mt-1">展示最近一次 `adb pair` / `adb connect` 命令输出</p>
          </div>
          <button
            type="button"
            onClick={handleClearConsole}
            className="text-gray-500 hover:text-gray-300 transition-colors"
            title="清空控制台"
          >
            <Trash2 size={16} />
          </button>
        </div>
        <div
          ref={consoleRef}
          className="flex-1 bg-[#141414] rounded-xl border border-gray-800 p-4 font-mono text-xs text-gray-400 overflow-y-auto space-y-2"
        >
          {consoleLines.map((line) => (
            <p
              key={line.id}
              className={`whitespace-pre-wrap break-all ${line.type === "command"
                  ? "text-blue-300"
                  : line.type === "success"
                    ? "text-emerald-300"
                    : line.type === "error"
                      ? "text-rose-300"
                      : "text-gray-500"
                }`}
            >
              {line.text}
            </p>
          ))}
        </div>
      </div>
    </div>
  );
}

function UrlTool() {
  const [input, setInput] = useState("");
  const [result, setResult] = useState("");
  const [resultLabel, setResultLabel] = useState<"编码结果" | "解码结果" | "转换结果">("转换结果");

  const handleEncode = () => {
    const nextResult = encodeURIComponent(input);
    setResult(nextResult);
    setResultLabel("编码结果");
  };

  const handleDecode = () => {
    try {
      const nextResult = decodeURIComponent(input);
      setResult(nextResult);
      setResultLabel("解码结果");
    } catch (error) {
      const message = `URL 解码失败：${String(error)}`;
      setResult(message);
      setResultLabel("转换结果");
      alert(message);
    }
  };

  const handleCopyResult = async () => {
    if (!result) {
      alert("当前没有可复制的结果。");
      return;
    }

    try {
      await navigator.clipboard.writeText(result);
    } catch (error) {
      alert(`复制失败：${String(error)}`);
    }
  };

  const handleClearInput = () => {
    setInput("");
    setResult("");
    setResultLabel("转换结果");
  };

  return (
    <div className="h-full max-w-5xl">
      <div className="bg-white p-6 md:p-8 rounded-2xl border border-gray-100 shadow-[0_2px_10px_-4px_rgba(0,0,0,0.05)] h-full flex flex-col gap-6 overflow-auto">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-purple-50 flex items-center justify-center text-purple-500">
            <LinkIcon size={20} />
          </div>
          <div>
            <h2 className="text-lg font-bold text-gray-900">URL 编解码</h2>
            <p className="text-sm text-gray-500 mt-0.5">上方输入原始内容，下方查看转换结果</p>
          </div>
        </div>

        <div className="flex flex-col gap-5 flex-1 min-h-max">
          <section className="flex flex-col min-h-0">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-3">
              <div>
                <h3 className="text-sm font-semibold text-gray-800">输入区域</h3>
                <p className="text-xs text-gray-500 mt-1">输入待编码或解码的 URL / 文本</p>
              </div>
              <button
                type="button"
                onClick={handleClearInput}
                className="inline-flex items-center justify-center gap-2 px-3 py-2 text-sm text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded-xl transition-colors self-start sm:self-auto"
              >
                <Trash2 size={14} />
                清空输入
              </button>
            </div>
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="输入或粘贴内容..."
              className="w-full min-h-[180px] p-4 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-purple-500/20 focus:border-purple-500 transition-all placeholder:text-gray-400 resize-none"
            ></textarea>
          </section>

          <div className="flex flex-col sm:flex-row sm:flex-wrap sm:items-center gap-3 sm:gap-4">
            <button
              type="button"
              onClick={handleEncode}
              className="inline-flex items-center justify-center gap-2 px-6 py-2.5 bg-purple-600 text-white font-medium rounded-xl hover:bg-purple-700 transition-all shadow-sm shadow-purple-500/20 active:scale-[0.98]"
            >
              URL 编码
            </button>
            <button
              type="button"
              onClick={handleDecode}
              className="inline-flex items-center justify-center gap-2 px-6 py-2.5 bg-white border border-gray-200 text-gray-700 font-medium rounded-xl hover:bg-gray-50 transition-all shadow-sm active:scale-[0.98]"
            >
              URL 解码
            </button>
            <button
              type="button"
              onClick={handleCopyResult}
              className="inline-flex items-center justify-center gap-2 px-4 py-2.5 text-gray-500 hover:text-gray-700 font-medium rounded-xl hover:bg-gray-100 transition-colors sm:ml-auto"
            >
              <Copy size={16} />
              复制结果
            </button>
          </div>

          <section className="flex flex-col min-h-0">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-3">
              <div>
                <h3 className="text-sm font-semibold text-gray-800">{resultLabel}</h3>
                <p className="text-xs text-gray-500 mt-1">这里展示最近一次转换后的内容</p>
              </div>
            </div>
            <textarea
              value={result}
              readOnly
              placeholder="转换结果将显示在这里..."
              className="w-full min-h-[180px] p-4 bg-gray-50 border border-gray-200 rounded-xl text-sm text-gray-700 focus:outline-none resize-none"
            ></textarea>
          </section>
        </div>
      </div>
    </div>
  );
}

function UnixTimestampTool() {
  const conversionButtonClass =
    "h-11 w-full px-3 rounded-xl border border-blue-500 text-blue-600 hover:bg-blue-50 transition-colors whitespace-nowrap";
  const timestampResultClass =
    "h-11 w-full px-3 bg-white border border-gray-200 rounded-xl text-sm text-gray-700";

  const [currentTimestamp, setCurrentTimestamp] = useState(() => Math.floor(Date.now() / 1000).toString());
  const [isTicking, setIsTicking] = useState(true);
  const [timestampInput, setTimestampInput] = useState(Math.floor(Date.now() / 1000).toString());
  const [timestampUnit, setTimestampUnit] = useState<TimestampUnit>("seconds");
  const [timestampResult, setTimestampResult] = useState("");
  const [dateTimeInput, setDateTimeInput] = useState("");
  const [dateTimeUnit, setDateTimeUnit] = useState<TimestampUnit>("seconds");
  const [dateTimeResult, setDateTimeResult] = useState("");
  const [dateParts, setDateParts] = useState({
    year: new Date().getFullYear().toString(),
    month: "",
    day: "",
    hour: "",
    minute: "",
    second: "",
  });
  const [partsUnit, setPartsUnit] = useState<TimestampUnit>("seconds");
  const [partsResult, setPartsResult] = useState("");

  useEffect(() => {
    if (!isTicking) return;

    const intervalId = window.setInterval(() => {
      setCurrentTimestamp(Math.floor(Date.now() / 1000).toString());
    }, 1000);

    return () => window.clearInterval(intervalId);
  }, [isTicking]);

  const refreshCurrentTimestamp = () => {
    setCurrentTimestamp(Math.floor(Date.now() / 1000).toString());
  };

  const handleConvertTimestamp = () => {
    const numericValue = Number(timestampInput.trim());
    if (!Number.isFinite(numericValue)) {
      alert("请输入有效的 Unix 时间戳。");
      return;
    }

    const timestampMs = timestampUnit === "seconds" ? numericValue * 1000 : numericValue;
    const parsedDate = new Date(timestampMs);

    if (Number.isNaN(parsedDate.getTime())) {
      alert("时间戳格式无效，无法转换。");
      return;
    }

    setTimestampResult(formatDateTime(parsedDate));
  };

  const handleConvertDateTimeString = () => {
    const parsedDate = parseDateTimeInput(dateTimeInput);
    if (!parsedDate) {
      alert("请输入有效时间，格式如 2026/03/10 12:30:45。");
      return;
    }

    setDateTimeResult(convertDateToTimestamp(parsedDate, dateTimeUnit).toString());
  };

  const handleDatePartChange = (
    field: keyof typeof dateParts,
    nextValue: string,
    maxLength: number
  ) => {
    setDateParts((prev) => ({
      ...prev,
      [field]: nextValue.replace(/\D/g, "").slice(0, maxLength),
    }));
  };

  const handleConvertDateParts = () => {
    const { year, month, day, hour, minute, second } = dateParts;
    if (!year || !month || !day || !hour || !minute || !second) {
      alert("请完整填写年月日时分秒。");
      return;
    }

    const parsedDate = new Date(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      Number(second)
    );

    if (
      parsedDate.getFullYear() !== Number(year)
      || parsedDate.getMonth() !== Number(month) - 1
      || parsedDate.getDate() !== Number(day)
      || parsedDate.getHours() !== Number(hour)
      || parsedDate.getMinutes() !== Number(minute)
      || parsedDate.getSeconds() !== Number(second)
    ) {
      alert("输入的日期时间无效，请检查后重试。");
      return;
    }

    setPartsResult(convertDateToTimestamp(parsedDate, partsUnit).toString());
  };

  const renderUnitToggle = (
    value: TimestampUnit,
    onChange: (value: TimestampUnit) => void
  ) => (
    <div className="inline-flex h-11 w-full min-w-[96px] rounded-xl border border-gray-200 bg-white p-1">
      <button
        type="button"
        onClick={() => onChange("seconds")}
        className={`flex-1 rounded-lg text-sm font-medium transition-colors ${value === "seconds" ? "bg-blue-50 text-blue-600" : "text-gray-500 hover:text-gray-700"
          }`}
      >
        秒
      </button>
      <button
        type="button"
        onClick={() => onChange("milliseconds")}
        className={`flex-1 rounded-lg text-sm font-medium transition-colors ${value === "milliseconds" ? "bg-blue-50 text-blue-600" : "text-gray-500 hover:text-gray-700"
          }`}
      >
        毫秒
      </button>
    </div>
  );

  return (
    <div className="max-w-6xl">
      <div className="bg-white rounded-2xl border border-gray-100 shadow-[0_2px_10px_-4px_rgba(0,0,0,0.05)] p-6 md:p-8 space-y-8">
        <div className="flex flex-col gap-4 rounded-2xl bg-gray-50 border border-gray-100 p-5">
          <div className="flex flex-col xl:flex-row xl:items-center gap-4 xl:gap-6">
            <div className="flex items-center gap-3 min-w-0">
              <div className="w-10 h-10 rounded-xl bg-blue-50 flex items-center justify-center text-blue-500 shrink-0">
                <Clock3 size={20} />
              </div>
              <div className="min-w-0">
                <h2 className="text-lg font-bold text-gray-900">Unix 时间戳</h2>
                <p className="text-sm text-gray-500 mt-0.5">当前时间戳与常用时间转换工具</p>
              </div>
            </div>
            <div className="xl:ml-auto flex flex-col lg:flex-row lg:flex-wrap lg:items-center gap-3">
              <span className="text-sm text-gray-700 whitespace-nowrap">现在的 Unix 时间戳是：</span>
              <div className="px-4 h-11 inline-flex items-center rounded-xl border border-orange-200 bg-white text-orange-500 font-medium whitespace-nowrap">
                {currentTimestamp}
              </div>
              <div className="flex flex-wrap gap-3">
                <button
                  type="button"
                  onClick={() => setIsTicking(true)}
                  className="px-4 h-11 rounded-xl border border-blue-500 text-blue-600 hover:bg-blue-50 transition-colors"
                >
                  开始
                </button>
                <button
                  type="button"
                  onClick={() => setIsTicking(false)}
                  className="px-4 h-11 rounded-xl border border-blue-500 text-blue-600 hover:bg-blue-50 transition-colors"
                >
                  停止
                </button>
                <button
                  type="button"
                  onClick={refreshCurrentTimestamp}
                  className="px-4 h-11 rounded-xl border border-blue-500 text-blue-600 hover:bg-blue-50 transition-colors"
                >
                  刷新
                </button>
              </div>
            </div>
          </div>
        </div>

        <div className="space-y-5">
          <div className="rounded-2xl border border-gray-100 bg-gray-50 p-4">
            <div className="grid grid-cols-1 xl:grid-cols-[230px_minmax(0,1fr)] gap-4 xl:gap-6 items-center">
              <label className="text-sm text-gray-700">Unix 时间戳 (Unix timestamp)</label>
              <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,220px)_96px_96px_minmax(220px,240px)] gap-3 items-center">
                <input
                  type="text"
                  inputMode="numeric"
                  value={timestampInput}
                  onChange={(e) => setTimestampInput(e.target.value.replace(/[^\d-]/g, ""))}
                  className="h-11 px-4 bg-white border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500"
                />
                {renderUnitToggle(timestampUnit, setTimestampUnit)}
                <button
                  type="button"
                  onClick={handleConvertTimestamp}
                  className={conversionButtonClass}
                >
                  转换
                </button>
                <input
                  type="text"
                  readOnly
                  value={timestampResult}
                  placeholder="转换结果"
                  className="h-11 px-4 bg-white border border-gray-200 rounded-xl text-sm text-gray-700"
                />
              </div>
            </div>
          </div>

          <div className="rounded-2xl border border-gray-100 bg-gray-50 p-4">
            <div className="grid grid-cols-1 xl:grid-cols-[230px_minmax(0,1fr)] gap-4 xl:gap-6 items-center">
              <label className="text-sm text-gray-700">时间（年/月/日 时:分:秒）</label>
              <div className="grid grid-cols-1 xl:grid-cols-[minmax(0,220px)_96px_220px_96px] gap-3 items-center">
                <input
                  type="text"
                  value={dateTimeInput}
                  onChange={(e) => setDateTimeInput(e.target.value)}
                  placeholder="例: 2026/03/10 12:30:45"
                  className="h-11 w-full px-4 bg-white border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500"
                />
                <button
                  type="button"
                  onClick={handleConvertDateTimeString}
                  className={conversionButtonClass}
                >
                  转换
                </button>
                <input
                  type="text"
                  readOnly
                  value={dateTimeResult}
                  placeholder="时间戳结果"
                  className={timestampResultClass}
                />
                {renderUnitToggle(dateTimeUnit, setDateTimeUnit)}
              </div>
            </div>
          </div>

          <div className="rounded-2xl border border-gray-100 bg-gray-50 p-4">
            <div className="grid grid-cols-1 xl:grid-cols-[80px_minmax(0,1fr)] gap-4 xl:gap-6 items-center">
              <label className="text-sm text-gray-700">时间</label>
              <div className="flex flex-col gap-3">
                <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-[94px_70px_70px_70px_70px_70px_96px_170px_96px] gap-2 items-center">
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      inputMode="numeric"
                      value={dateParts.year}
                      onChange={(e) => handleDatePartChange("year", e.target.value, 4)}
                      className="h-11 w-full min-w-0 px-2.5 bg-white border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500"
                    />
                    <span className="text-sm text-gray-600 whitespace-nowrap">年</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      inputMode="numeric"
                      value={dateParts.month}
                      onChange={(e) => handleDatePartChange("month", e.target.value, 2)}
                      className="h-11 w-full min-w-0 px-2.5 bg-white border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500"
                    />
                    <span className="text-sm text-gray-600 whitespace-nowrap">月</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      inputMode="numeric"
                      value={dateParts.day}
                      onChange={(e) => handleDatePartChange("day", e.target.value, 2)}
                      className="h-11 w-full min-w-0 px-2.5 bg-white border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500"
                    />
                    <span className="text-sm text-gray-600 whitespace-nowrap">日</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      inputMode="numeric"
                      value={dateParts.hour}
                      onChange={(e) => handleDatePartChange("hour", e.target.value, 2)}
                      className="h-11 w-full min-w-0 px-2.5 bg-white border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500"
                    />
                    <span className="text-sm text-gray-600 whitespace-nowrap">时</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      inputMode="numeric"
                      value={dateParts.minute}
                      onChange={(e) => handleDatePartChange("minute", e.target.value, 2)}
                      className="h-11 w-full min-w-0 px-2.5 bg-white border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500"
                    />
                    <span className="text-sm text-gray-600 whitespace-nowrap">分</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      inputMode="numeric"
                      value={dateParts.second}
                      onChange={(e) => handleDatePartChange("second", e.target.value, 2)}
                      className="h-11 w-full min-w-0 px-2.5 bg-white border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500"
                    />
                    <span className="text-sm text-gray-600 whitespace-nowrap">秒</span>
                  </div>
                  <button
                    type="button"
                    onClick={handleConvertDateParts}
                    className={conversionButtonClass}
                  >
                    转换
                  </button>
                  <input
                    type="text"
                    readOnly
                    value={partsResult}
                    placeholder="时间戳结果"
                    className={timestampResultClass}
                  />
                  {renderUnitToggle(partsUnit, setPartsUnit)}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function JsonTreeNode({
  label,
  value,
  depth,
  path,
  expandedPaths,
  onToggle,
  wrapText = false,
}: {
  label: string | null;
  value: JsonValue;
  depth: number;
  path: string;
  expandedPaths: Set<string>;
  onToggle: (path: string) => void;
  wrapText?: boolean;
}) {
  const paddingLeft = depth * 16;

  if (!isJsonContainer(value)) {
    const leafClassName = value === null
      ? "text-gray-500"
      : typeof value === "string"
        ? "text-emerald-600"
        : typeof value === "number"
          ? "text-blue-600"
          : "text-amber-600";

    return (
      <div
        className={`py-0.5 text-sm leading-5 ${wrapText ? "break-all" : ""}`}
        style={{ paddingLeft }}
      >
        {label && (
          <>
            <span className={`font-medium text-sky-700 ${wrapText ? "break-all" : ""}`}>{label}</span>
            <span className="text-gray-300 mx-2">:</span>
          </>
        )}
        <span className={`${leafClassName} ${wrapText ? "break-all" : ""}`}>{formatJsonLeafValue(value)}</span>
      </div>
    );
  }

  const isExpanded = expandedPaths.has(path);
  const entries = Array.isArray(value)
    ? value.map((item, index) => ({
      label: `[${index}]`,
      value: item,
      path: appendJsonPath(path, index),
    }))
    : Object.entries(value).map(([key, nestedValue]) => ({
      label: key,
      value: nestedValue,
      path: appendJsonPath(path, key),
    }));

  return (
    <div>
      <button
        type="button"
        onClick={() => onToggle(path)}
        className={`flex w-full gap-2 rounded-lg py-1 pr-2 text-left text-sm leading-5 text-gray-700 hover:bg-gray-50 transition-colors ${wrapText ? "items-start" : "items-center"}`}
        style={{ paddingLeft }}
      >
        {isExpanded ? <ChevronDown size={15} className="text-gray-400" /> : <ChevronRight size={15} className="text-gray-400" />}
        <span className={`font-medium text-sky-700 ${wrapText ? "break-all" : ""}`}>{label ?? "根节点"}</span>
        <span className="text-gray-400">{getJsonContainerSummary(value)}</span>
      </button>
      {isExpanded && (
        <div>
          {entries.length > 0 ? (
            entries.map((entry) => (
              <JsonTreeNode
                key={entry.path}
                label={entry.label}
                value={entry.value}
                depth={depth + 1}
                path={entry.path}
                expandedPaths={expandedPaths}
                onToggle={onToggle}
                wrapText={wrapText}
              />
            ))
          ) : (
            <div
              className={`py-0.5 text-sm leading-5 text-gray-400 italic ${wrapText ? "break-all" : ""}`}
              style={{ paddingLeft: paddingLeft + 32 }}
            >
              空节点
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function JsonFormattedNode({
  value,
  depth,
  propertyKey,
  withComma,
  wrapText = false,
}: {
  value: JsonValue;
  depth: number;
  propertyKey?: string;
  withComma?: boolean;
  wrapText?: boolean;
}) {
  const paddingLeft = depth * 18;

  const renderPropertyKey = () => (
    propertyKey ? (
      <>
        <span className={`text-sky-700 ${wrapText ? "break-all" : ""}`}>"{propertyKey}"</span>
        <span className="text-gray-400">: </span>
      </>
    ) : null
  );

  if (!isJsonContainer(value)) {
    const leafClassName = value === null
      ? "text-gray-500"
      : typeof value === "string"
        ? "text-emerald-600"
        : typeof value === "number"
          ? "text-indigo-600"
          : "text-amber-600";

    return (
      <div className={`py-0 font-mono text-sm leading-5 ${wrapText ? "whitespace-pre-wrap break-all" : "whitespace-pre"}`} style={{ paddingLeft }}>
        {renderPropertyKey()}
        <span className={`${leafClassName} ${wrapText ? "break-all" : ""}`}>{formatJsonLeafValue(value)}</span>
        {withComma && <span className="text-gray-400">,</span>}
      </div>
    );
  }

  const entries = Array.isArray(value)
    ? value.map((item, index) => ({ key: index.toString(), value: item }))
    : Object.entries(value).map(([key, nestedValue]) => ({ key, value: nestedValue }));

  const openBracket = Array.isArray(value) ? "[" : "{";
  const closeBracket = Array.isArray(value) ? "]" : "}";

  if (entries.length === 0) {
    return (
      <div className={`py-0 font-mono text-sm leading-5 ${wrapText ? "whitespace-pre-wrap break-all" : "whitespace-pre"}`} style={{ paddingLeft }}>
        {renderPropertyKey()}
        <span className="text-gray-700">{openBracket}{closeBracket}</span>
        {withComma && <span className="text-gray-400">,</span>}
      </div>
    );
  }

  return (
    <div>
      <div className={`py-0 font-mono text-sm leading-5 text-gray-700 ${wrapText ? "whitespace-pre-wrap break-all" : "whitespace-pre"}`} style={{ paddingLeft }}>
        {renderPropertyKey()}
        {openBracket}
      </div>
      {entries.map((entry, index) => (
        <JsonFormattedNode
          key={`${depth}_${entry.key}_${index}`}
          value={entry.value}
          depth={depth + 1}
          propertyKey={Array.isArray(value) ? undefined : entry.key}
          withComma={index < entries.length - 1}
          wrapText={wrapText}
        />
      ))}
      <div className={`py-0 font-mono text-sm leading-5 text-gray-700 ${wrapText ? "whitespace-pre-wrap break-all" : "whitespace-pre"}`} style={{ paddingLeft }}>
        {closeBracket}
        {withComma && <span className="text-gray-400">,</span>}
      </div>
    </div>
  );
}

function JsonFormatterTool() {
  const [input, setInput] = useState("");
  const [formattedResult, setFormattedResult] = useState("");
  const [parsedResult, setParsedResult] = useState<JsonValue | undefined>(undefined);
  const [resultTab, setResultTab] = useState<JsonResultTab>("formatted");
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [statusTone, setStatusTone] = useState<"success" | "error" | "info">("info");
  const [statusSource, setStatusSource] = useState<JsonStatusSource>("action");
  const [expandedPaths, setExpandedPaths] = useState<string[]>([]);
  const [validationState, setValidationState] = useState<JsonValidationState>("idle");
  const [validationInfo, setValidationInfo] = useState<JsonValidationInfo | null>(null);
  const [isResultPreviewOpen, setIsResultPreviewOpen] = useState(false);
  const [wrapResultText, setWrapResultText] = useState(true);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  const expandedPathSet = new Set(expandedPaths);
  const allExpandablePaths = parsedResult !== undefined ? collectExpandableJsonPaths(parsedResult) : [];
  const hasTreeView = parsedResult !== undefined && isJsonContainer(parsedResult);
  const shouldShowStatusBanner = statusMessage && statusSource === "action";

  const resetPreview = () => {
    setFormattedResult("");
    setParsedResult(undefined);
    setExpandedPaths([]);
    setValidationState("idle");
    setValidationInfo(null);
  };

  const updatePreview = ({
    sourceText,
    mode,
    keepActionStatus = false,
  }: {
    sourceText: string;
    mode: "json" | "text";
    keepActionStatus?: boolean;
  }) => {
    if (!keepActionStatus || statusSource === "validation") {
      setStatusMessage(null);
    }

    if (!sourceText.trim()) {
      resetPreview();
      return;
    }

    if (mode === "text") {
      setFormattedResult(sourceText);
      setParsedResult(undefined);
      setExpandedPaths([]);
      setValidationState("text");
      setValidationInfo(null);
      return;
    }

    try {
      const { parsed, formatted } = parseJsonInput(sourceText, false);
      setFormattedResult(formatted);
      setParsedResult(parsed);
      setExpandedPaths(collectExpandableJsonPaths(parsed));
      setValidationState("valid");
      setValidationInfo(null);
    } catch (error) {
      setFormattedResult("");
      setParsedResult(undefined);
      setExpandedPaths([]);
      setValidationState("invalid");
      setValidationInfo(buildJsonValidationInfo(sourceText, error));
    }
  };

  const handleInputChange = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
    const nextValue = event.target.value;
    setInput(nextValue);
    updatePreview({ sourceText: nextValue, mode: "json", keepActionStatus: false });
  };

  const handleFormatInput = () => {
    if (!input.trim()) {
      handleClearAll();
      return;
    }

    try {
      const { formatted } = parseJsonInput(input, false);
      setInput(formatted);
      updatePreview({ sourceText: formatted, mode: "json", keepActionStatus: false });
    } catch (error) {
      setValidationState("invalid");
      setValidationInfo(buildJsonValidationInfo(input, error));
      setParsedResult(undefined);
      setFormattedResult("");
      setExpandedPaths([]);
    }
  };

  const handleRemoveEscapes = () => {
    const decodedText = decodeEscapedJsonText(input);
    setInput(decodedText);
    updatePreview({ sourceText: decodedText, mode: "json", keepActionStatus: false });
  };

  const handleAddEscapes = () => {
    try {
      const escapedText = escapeJsonText(input);
      setInput(escapedText);
      updatePreview({ sourceText: escapedText, mode: "text", keepActionStatus: true });
      setStatusMessage("已增加转义，可直接复制结果。");
      setStatusTone("success");
      setStatusSource("action");
      setResultTab("formatted");
    } catch (error) {
      setStatusMessage(`增加转义失败：${String(error)}`);
      setStatusTone("error");
      setStatusSource("validation");
      setValidationState("invalid");
      setValidationInfo(buildJsonValidationInfo(input, error));
      setParsedResult(undefined);
      setFormattedResult("");
      setExpandedPaths([]);
    }
  };

  const handleCopyResult = async () => {
    if (!formattedResult) {
      alert("当前没有可复制的格式化结果。");
      return;
    }

    try {
      await navigator.clipboard.writeText(formattedResult);
      setStatusMessage("格式化结果已复制。");
      setStatusTone("success");
      setStatusSource("action");
    } catch (error) {
      alert(`复制失败：${String(error)}`);
    }
  };

  const handleClearAll = () => {
    setInput("");
    resetPreview();
    setStatusMessage("内容已清空。");
    setStatusTone("info");
    setStatusSource("action");
  };

  const handleToggleNode = (path: string) => {
    setExpandedPaths((prev) => (
      prev.includes(path) ? prev.filter((item) => item !== path) : [...prev, path]
    ));
  };

  const focusInputByLine = (lineNumber: number, columnNumber?: number | null) => {
    const textarea = inputRef.current;
    if (!textarea) return;

    const lines = input.split(/\r?\n/);
    const safeLineNumber = Math.max(1, Math.min(lineNumber, Math.max(1, lines.length)));
    const lineStartIndex = lines
      .slice(0, safeLineNumber - 1)
      .reduce((total, line) => total + line.length + 1, 0);
    const nextPosition = lineStartIndex + Math.max(0, (columnNumber ?? 1) - 1);

    textarea.focus();
    textarea.setSelectionRange(nextPosition, nextPosition);
  };

  const renderValidationPanel = () => {
    if (validationState !== "invalid" || !validationInfo) {
      return null;
    }

    return (
      <div className="mb-3 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h4 className="text-sm font-semibold text-gray-800">校验结果</h4>
          <div className="mt-1 text-sm text-amber-700">
            {validationInfo.message}
            {(validationInfo.line !== null || validationInfo.column !== null) && (
              <span className="ml-2 text-xs font-medium">
                第 {validationInfo.line ?? "?"} 行，第 {validationInfo.column ?? "?"} 列
              </span>
            )}
          </div>
        </div>
      </div>

      {validationInfo.excerptLines.length > 0 && (
        <div className="mt-3 overflow-auto rounded-xl border border-amber-100 bg-white p-3">
          <div className="space-y-0.5 font-mono text-xs leading-4 text-gray-700">
            {validationInfo.excerptLines.map((line) => (
              <button
                key={`json_error_line_${line.lineNumber}`}
                type="button"
                onClick={() => focusInputByLine(line.lineNumber, line.isTarget ? validationInfo.column : 1)}
                className={`block w-full rounded-lg px-2 py-1 text-left transition-colors ${line.isTarget ? "bg-amber-50 hover:bg-amber-100" : "hover:bg-gray-50"}`}
                title="点击定位到左侧输入框"
              >
                <div className={`flex gap-3 ${line.isTarget ? "text-amber-800" : "text-gray-600"}`}>
                  <span className="w-8 shrink-0 text-right text-gray-400">{line.lineNumber}</span>
                  <span className="flex-1 whitespace-pre-wrap break-all">{line.text || " "}</span>
                </div>
                {line.isTarget && validationInfo.column !== null && (
                  <div className="flex gap-3 text-amber-600">
                    <span className="w-8 shrink-0" />
                    <span className="flex-1 whitespace-pre">
                      {" ".repeat(Math.max(0, validationInfo.column - 1))}
                      ^
                    </span>
                  </div>
                )}
              </button>
            ))}
          </div>
        </div>
      )}
      </div>
    );
  };

  const renderResultContent = (minHeightClass = "min-h-[360px]") => (
    resultTab === "formatted" ? (
      <div className={`flex-1 ${minHeightClass} rounded-xl border border-gray-200 bg-white p-4 ${wrapResultText ? "overflow-y-auto overflow-x-hidden" : "overflow-auto"}`}>
        {parsedResult !== undefined ? (
          <JsonFormattedNode value={parsedResult} depth={0} wrapText={wrapResultText} />
        ) : (
          <pre className={`font-mono text-sm leading-5 text-gray-700 ${wrapResultText ? "whitespace-pre-wrap break-all" : "whitespace-pre"}`}>
            {formattedResult || "格式化结果将显示在这里..."}
          </pre>
        )}
      </div>
    ) : (
      <div className={`flex-1 ${minHeightClass} rounded-xl border border-gray-200 bg-white p-4 ${wrapResultText ? "overflow-y-auto overflow-x-hidden" : "overflow-auto"}`}>
        {parsedResult !== undefined ? (
          <JsonTreeNode
            label={null}
            value={parsedResult}
            depth={0}
            path={JSON.stringify(["$"])}
            expandedPaths={expandedPathSet}
            onToggle={handleToggleNode}
            wrapText={wrapResultText}
          />
        ) : (
          <div className="h-full flex items-center justify-center text-sm text-gray-400">
            暂无可展示的 JSON 树，请先完成格式化。
          </div>
        )}
      </div>
    )
  );

  return (
    <div className="h-full">
      {isResultPreviewOpen && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/45 backdrop-blur-sm p-4">
          <div className="w-full max-w-6xl h-[calc(100vh-3rem)] rounded-2xl bg-white shadow-2xl border border-gray-100 flex flex-col overflow-hidden">
            <div className="flex items-center justify-between gap-4 px-5 py-4 border-b border-gray-100 bg-gray-50">
              <div>
                <h3 className="text-base font-bold text-gray-900">JSON 结果放大查看</h3>
                <p className="text-xs text-gray-500 mt-1">当前视图：{resultTab === "formatted" ? "文本" : "树结构"}</p>
              </div>
              <button
                type="button"
                onClick={() => setIsResultPreviewOpen(false)}
                className="p-2 rounded-xl text-gray-400 hover:text-gray-900 hover:bg-gray-200 transition-colors"
                title="关闭放大窗口"
              >
                <X size={18} />
              </button>
            </div>
            <div className="flex-1 overflow-auto p-5 bg-gray-50">
              {renderValidationPanel()}
              {renderResultContent("min-h-0")}
            </div>
          </div>
        </div>
      )}
      <div className="h-full overflow-auto">
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-6 min-h-full">
          <section className="flex min-h-[420px] flex-col rounded-2xl border border-gray-100 bg-gray-50 p-4">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
              <h3 className="text-sm font-semibold text-gray-800">原始 JSON</h3>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={handleFormatInput}
                  className="inline-flex min-w-[88px] items-center justify-center px-3 py-2 text-sm bg-cyan-600 text-white font-medium rounded-xl hover:bg-cyan-700 transition-all shadow-sm shadow-cyan-500/20 active:scale-[0.98]"
                >
                  格式化
                </button>
                <button
                  type="button"
                  onClick={handleRemoveEscapes}
                  className="inline-flex min-w-[88px] items-center justify-center px-3 py-2 text-sm bg-white border border-gray-200 text-gray-700 font-medium rounded-xl hover:bg-gray-50 transition-all shadow-sm active:scale-[0.98]"
                >
                  去除转义
                </button>
                <button
                  type="button"
                  onClick={handleAddEscapes}
                  className="inline-flex min-w-[88px] items-center justify-center px-3 py-2 text-sm bg-white border border-gray-200 text-gray-700 font-medium rounded-xl hover:bg-gray-50 transition-all shadow-sm active:scale-[0.98]"
                >
                  增加转义
                </button>
                <button
                  type="button"
                  onClick={handleClearAll}
                  className="inline-flex h-9 w-9 items-center justify-center text-gray-500 hover:text-gray-700 font-medium rounded-xl hover:bg-gray-100 transition-colors"
                  title="一键清空"
                >
                  <Trash2 size={16} />
                </button>
              </div>
            </div>
            <textarea
              ref={inputRef}
              value={input}
              onChange={handleInputChange}
              placeholder={"例如：{\"name\":\"bear\",\"tools\":[\"json\",\"url\"]}\n或：\"{\\\"name\\\":\\\"bear\\\"}\""}
              className="flex-1 w-full min-h-[360px] rounded-xl border border-gray-200 bg-white p-4 font-mono text-sm text-gray-700 focus:outline-none focus:ring-2 focus:ring-cyan-500/20 focus:border-cyan-500 transition-all resize-none"
            />
          </section>

          <section className="flex min-h-[420px] flex-col rounded-2xl border border-gray-100 bg-gray-50 p-4">
            <div className="mb-3 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
              <h3 className="text-sm font-semibold text-gray-800">结果区域</h3>
              <div className="flex flex-wrap gap-2">
                <div className="inline-flex rounded-xl border border-gray-200 bg-white p-1">
                  <button
                    type="button"
                    onClick={() => setResultTab("formatted")}
                    className={`min-w-[72px] px-3 py-1.5 text-sm font-medium rounded-lg transition-colors ${resultTab === "formatted" ? "bg-cyan-50 text-cyan-700" : "text-gray-500 hover:text-gray-700"}`}
                  >
                    文本
                  </button>
                  <button
                    type="button"
                    onClick={() => setResultTab("tree")}
                    className={`min-w-[72px] px-3 py-1.5 text-sm font-medium rounded-lg transition-colors ${resultTab === "tree" ? "bg-cyan-50 text-cyan-700" : "text-gray-500 hover:text-gray-700"}`}
                  >
                    树结构
                  </button>
                </div>
                {resultTab === "tree" && hasTreeView && (
                  <>
                    <button
                      type="button"
                      onClick={() => setExpandedPaths(allExpandablePaths)}
                      className="px-3 py-1.5 text-sm font-medium rounded-xl border border-gray-200 bg-white text-gray-700 hover:bg-gray-50 transition-colors"
                    >
                      全展开
                    </button>
                    <button
                      type="button"
                      onClick={() => setExpandedPaths([JSON.stringify(["$"])])}
                      className="px-3 py-1.5 text-sm font-medium rounded-xl border border-gray-200 bg-white text-gray-700 hover:bg-gray-50 transition-colors"
                    >
                      全折叠
                    </button>
                  </>
                )}
                <button
                  type="button"
                  onClick={handleCopyResult}
                  className="inline-flex h-[42px] w-[42px] items-center justify-center text-gray-500 hover:text-gray-700 font-medium rounded-xl hover:bg-gray-100 transition-colors"
                  title="复制结果"
                >
                  <Copy size={16} />
                </button>
                <button
                  type="button"
                  onClick={() => setWrapResultText((prev) => !prev)}
                  className={`inline-flex h-[42px] w-[42px] items-center justify-center rounded-xl transition-colors ${wrapResultText ? "bg-cyan-50 text-cyan-700 hover:bg-cyan-100" : "text-gray-500 hover:text-gray-700 hover:bg-gray-100"}`}
                  title={wrapResultText ? "关闭自动换行" : "开启自动换行"}
                >
                  <WrapText size={16} />
                </button>
                <button
                  type="button"
                  onClick={() => setIsResultPreviewOpen(true)}
                  className="inline-flex h-[42px] w-[42px] items-center justify-center text-gray-500 hover:text-gray-700 font-medium rounded-xl hover:bg-gray-100 transition-colors"
                  title="放大"
                >
                  <Maximize2 size={16} />
                </button>
              </div>
            </div>

            {shouldShowStatusBanner && (
              <div className={`mb-3 rounded-xl px-3 py-2 text-sm ${statusTone === "success" ? "bg-emerald-50 text-emerald-700" : statusTone === "error" ? "bg-amber-50 text-amber-700" : "bg-gray-100 text-gray-600"}`}>
                {statusMessage}
              </div>
            )}

            {renderValidationPanel()}
            {renderResultContent()}
          </section>
        </div>
      </div>
    </div>
  );
}

// =======================
// 可拖拽菜单项组件 (左侧)
// =======================
function SortableNavItem({
  item,
  isActive,
  onClick,
}: {
  item: typeof INITIAL_TOOLS[0];
  isActive: boolean;
  onClick: (id: string) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: item.id });

  const style = {
    transform: CSS.Translate.toString(transform),
    transition,
    zIndex: isDragging ? 50 : 0,
  };

  const Icon = item.icon;

  return (
    <li ref={setNodeRef} style={style} className={`relative ${isDragging ? "opacity-40" : ""}`}>
      <div
        className={`w-full flex items-center p-1 rounded-xl transition-all duration-200 group ${isActive
            ? "bg-blue-50 text-blue-600 font-medium"
            : "text-gray-500 hover:bg-gray-50 hover:text-gray-900"
          }`}
      >
        <div
          {...attributes}
          {...listeners}
          className="cursor-grab active:cursor-grabbing p-1.5 mr-1 rounded-md text-gray-300 hover:text-gray-500 hover:bg-gray-200 transition-colors opacity-0 group-hover:opacity-100"
          title="按住拖拽排序"
        >
          <GripVertical size={14} />
        </div>
        <button
          onClick={() => onClick(item.id)}
          className="flex-1 flex items-center gap-2.5 py-1.5 text-left"
        >
          <Icon size={18} className={isActive ? "text-blue-500" : "text-gray-400"} />
          {item.name}
        </button>
      </div>
    </li>
  );
}

// =======================
// 可拖拽 Tab 项组件 (顶部)
// =======================
function SortableTab({
  inst,
  isActive,
  onClick,
  onClose,
  onContextMenu,
}: {
  inst: ToolInstance;
  isActive: boolean;
  onClick: () => void;
  onClose: (e: React.MouseEvent, id: string) => void;
  onContextMenu: (e: React.MouseEvent, id: string) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: inst.instanceId });

  const style = {
    transform: CSS.Translate.toString(transform),
    transition,
    zIndex: isDragging ? 50 : isActive ? 10 : 0,
    marginBottom: isActive ? "-1px" : "0",
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      onClick={onClick}
      onContextMenu={(e) => onContextMenu(e, inst.instanceId)}
      className={`group relative flex items-center gap-2 px-3 h-9 min-w-[130px] max-w-[220px] rounded-t-xl cursor-pointer transition-all select-none border ${isActive
          ? "bg-[var(--panel-bg)] border-gray-200 border-b-[var(--panel-bg)] text-blue-700 font-medium"
          : "bg-gray-100 border-gray-200 text-gray-600 hover:bg-gray-50"
        } ${isDragging ? "opacity-50" : "opacity-100"} ${isActive ? "z-10 -mb-[1px]" : "z-0"
        }`}
    >
      <span className="truncate flex-1 text-xs select-none pointer-events-none">{inst.title}</span>
      <button
        onClick={(e) => {
          e.stopPropagation();
          onClose(e, inst.instanceId);
        }}
        onPointerDown={(e) => e.stopPropagation()}
        className={`p-1 rounded-md transition-colors ${isActive
            ? "text-gray-500 hover:bg-gray-100 hover:text-gray-800"
            : "opacity-0 group-hover:opacity-100 text-gray-400 hover:bg-gray-200 hover:text-gray-700"
          }`}
        title="关闭"
      >
        <X size={12} />
      </button>
    </div>
  );
}

// =======================
// 主应用入口
// =======================
function App() {
  const [tools, setTools] = useState(INITIAL_TOOLS);
  const [activeToolId, setActiveToolId] = useState<string>("agent-launcher");
  const [instances, setInstances] = useState<ToolInstance[]>([
    { instanceId: "inst_init_agent", toolId: "agent-launcher", title: "Agent 启动" },
  ]);
  const [activeTabIds, setActiveTabIds] = useState<Record<string, string>>({
    "agent-launcher": "inst_init_agent",
  });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [autoStartEnabled, setAutoStartEnabled] = useState(false);
  const [autoStartLoading, setAutoStartLoading] = useState(false);
  const [autoStartError, setAutoStartError] = useState<string | null>(null);
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => getInitialThemeMode());
  const [globalShortcutInput, setGlobalShortcutInput] = useState(() => getInitialGlobalShortcut());
  const [globalShortcutMessage, setGlobalShortcutMessage] = useState<string | null>(null);
  const registeredShortcutRef = useRef<string | null>(null);

  // 右键菜单状态
  const [contextMenu, setContextMenu] = useState<{
    show: boolean;
    x: number;
    y: number;
    targetInstanceId: string | null;
  }>({
    show: false,
    x: 0,
    y: 0,
    targetInstanceId: null,
  });

  // 监听全局点击事件，点击其他区域关闭右键菜单
  useEffect(() => {
    const handleClick = () => {
      setContextMenu((prev) => ({ ...prev, show: false }));
    };
    window.addEventListener("click", handleClick);
    return () => window.removeEventListener("click", handleClick);
  }, []);

  useEffect(() => {
    localStorage.setItem(THEME_STORAGE_KEY, themeMode);
  }, [themeMode]);

  useEffect(() => {
    let isMounted = true;
    const stored = getInitialGlobalShortcut();
    if (!stored) return () => {
      isMounted = false;
    };

    const registerStoredShortcut = async () => {
      try {
        await invoke("set_global_shortcut", { shortcut: stored });
        if (isMounted) {
          registeredShortcutRef.current = stored;
          setGlobalShortcutMessage(null);
        }
      } catch (error) {
        if (isMounted) {
          setGlobalShortcutMessage(`快捷键注册失败: ${String(error)}`);
        }
      }
    };

    void registerStoredShortcut();

    return () => {
      isMounted = false;
    };
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    const media = window.matchMedia("(prefers-color-scheme: dark)");

    const applyTheme = (isDark: boolean) => {
      root.dataset.theme = isDark ? "dark" : "light";
      root.style.colorScheme = isDark ? "dark" : "light";
    };

    const resolveAndApply = () => {
      if (themeMode === "dark") {
        applyTheme(true);
      } else if (themeMode === "light") {
        applyTheme(false);
      } else {
        applyTheme(media.matches);
      }
    };

    resolveAndApply();

    if (themeMode !== "system") return undefined;

    const handleChange = (event: MediaQueryListEvent) => {
      applyTheme(event.matches);
    };

    if (typeof media.addEventListener === "function") {
      media.addEventListener("change", handleChange);
      return () => media.removeEventListener("change", handleChange);
    }

    media.addListener(handleChange);
    return () => media.removeListener(handleChange);
  }, [themeMode]);

  useEffect(() => {
    let isMounted = true;

    const loadAutostartState = async () => {
      setAutoStartLoading(true);
      try {
        const enabled = await isAutostartEnabled();
        if (isMounted) {
          setAutoStartEnabled(enabled);
          setAutoStartError(null);
        }
      } catch (error) {
        if (isMounted) {
          setAutoStartError("当前环境暂不支持开机启动。");
        }
      } finally {
        if (isMounted) {
          setAutoStartLoading(false);
        }
      }
    };

    void loadAutostartState();
    return () => {
      isMounted = false;
    };
  }, []);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  // 左侧菜单的拖拽处理
  const handleMenuDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (over && active.id !== over.id) {
      setTools((items) => {
        const oldIndex = items.findIndex((item) => item.id === active.id);
        const newIndex = items.findIndex((item) => item.id === over.id);
        return arrayMove(items, oldIndex, newIndex);
      });
    }
  };

  // 顶部 Tab 的拖拽处理
  const handleTabDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (over && active.id !== over.id) {
      setInstances((items) => {
        const oldIndex = items.findIndex((item) => item.instanceId === active.id);
        const newIndex = items.findIndex((item) => item.instanceId === over.id);
        return arrayMove(items, oldIndex, newIndex);
      });
    }
  };

  const handleToolClick = (toolId: string) => {
    setActiveToolId(toolId);
    const toolConfig = tools.find((t) => t.id === toolId);
    if (toolConfig?.singleton) return;

    const hasInstances = instances.some((i) => i.toolId === toolId);
    if (!hasInstances) {
      const newInstId = generateInstanceId();
      setInstances((prev) => [...prev, { instanceId: newInstId, toolId, title: toolConfig?.name || "新标签页" }]);
      setActiveTabIds((prev) => ({ ...prev, [toolId]: newInstId }));
    }
  };

  const handleNewTab = () => {
    const toolConfig = tools.find((t) => t.id === activeToolId);
    // 如果是单例模式，禁止新建标签页
    if (toolConfig?.singleton) return;

    const existingCount = instances.filter((i) => i.toolId === activeToolId).length;
    const title = existingCount === 0 ? (toolConfig?.name || "新标签页") : `${toolConfig?.name} ${existingCount + 1}`;

    const newInstId = generateInstanceId();
    setInstances((prev) => [...prev, { instanceId: newInstId, toolId: activeToolId, title }]);
    setActiveTabIds((prev) => ({ ...prev, [activeToolId]: newInstId }));
  };

  const handleCloseTab = (e: React.MouseEvent | null, instanceIdToClose: string) => {
    if (e) e.stopPropagation();
    setInstances((prev) => {
      const newInstances = prev.filter((i) => i.instanceId !== instanceIdToClose);
      if (activeTabIds[activeToolId] === instanceIdToClose) {
        const remainingToolInstances = newInstances.filter((i) => i.toolId === activeToolId);
        if (remainingToolInstances.length > 0) {
          const closedIndex = prev.filter((i) => i.toolId === activeToolId).findIndex((i) => i.instanceId === instanceIdToClose);
          const nextActive = remainingToolInstances[Math.max(0, closedIndex - 1)];
          setActiveTabIds((prevIds) => ({ ...prevIds, [activeToolId]: nextActive.instanceId }));
        } else {
          setActiveTabIds((prevIds) => {
            const newIds = { ...prevIds };
            delete newIds[activeToolId];
            return newIds;
          });
        }
      }
      return newInstances;
    });
  };

  // 右键菜单打开处理
  const handleContextMenu = (e: React.MouseEvent, instanceId: string) => {
    e.preventDefault();
    setContextMenu({
      show: true,
      x: e.pageX,
      y: e.pageY,
      targetInstanceId: instanceId,
    });
  };

  // 关闭当前工具的所有标签页
  const handleCloseAllTabs = () => {
    setInstances((prev) => prev.filter((i) => i.toolId !== activeToolId));
    setActiveTabIds((prev) => {
      const newIds = { ...prev };
      delete newIds[activeToolId];
      return newIds;
    });
    setContextMenu((prev) => ({ ...prev, show: false }));
  };

  // 关闭当前工具的其他标签页
  const handleCloseOtherTabs = () => {
    if (!contextMenu.targetInstanceId) return;
    const targetId = contextMenu.targetInstanceId;

    setInstances((prev) => prev.filter((i) => i.toolId !== activeToolId || i.instanceId === targetId));
    setActiveTabIds((prev) => ({ ...prev, [activeToolId]: targetId }));
    setContextMenu((prev) => ({ ...prev, show: false }));
  };

  const handleToggleAutostart = async () => {
    if (autoStartLoading || autoStartError) return;
    const nextValue = !autoStartEnabled;
    setAutoStartLoading(true);

    try {
      if (nextValue) {
        await enableAutostart();
      } else {
        await disableAutostart();
      }
      setAutoStartEnabled(nextValue);
    } catch (error) {
      console.error("Failed to toggle autostart:", error);
      alert(`设置开机启动失败: ${String(error)}`);
    } finally {
      setAutoStartLoading(false);
    }
  };

  const handleApplyGlobalShortcut = async (overrideValue?: string) => {
    const nextShortcut = (overrideValue ?? globalShortcutInput).trim();
    const previousShortcut = registeredShortcutRef.current;

    if (nextShortcut === previousShortcut) {
      setGlobalShortcutMessage("快捷键未变化。");
      return;
    }

    setGlobalShortcutMessage(null);

    if (!nextShortcut) {
      await invoke("clear_global_shortcut");
      localStorage.removeItem(GLOBAL_SHORTCUT_STORAGE_KEY);
      registeredShortcutRef.current = null;
      setGlobalShortcutMessage("已清除快捷键。");
      return;
    }

    try {
      await invoke("set_global_shortcut", { shortcut: nextShortcut });
      registeredShortcutRef.current = nextShortcut;
      localStorage.setItem(GLOBAL_SHORTCUT_STORAGE_KEY, nextShortcut);
      setGlobalShortcutMessage("快捷键已更新。");
    } catch (error) {
      registeredShortcutRef.current = previousShortcut;
      setGlobalShortcutMessage(`快捷键注册失败: ${String(error)}`);
    }
  };

  const handleClearGlobalShortcut = () => {
    setGlobalShortcutInput("");
    void handleApplyGlobalShortcut("");
  };

  const handleGlobalShortcutKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Tab") return;

    event.preventDefault();

    if (event.key === "Backspace" || event.key === "Delete") {
      setGlobalShortcutInput("");
      setGlobalShortcutMessage("已清空输入，点击保存后生效。");
      return;
    }

    if (event.key === "Escape") {
      event.currentTarget.blur();
      return;
    }

    const nextShortcut = formatGlobalShortcut(event);
    if (!nextShortcut) {
      setGlobalShortcutMessage("请继续按下主键，例如字母、数字、方向键或 F1-F12。");
      return;
    }

    setGlobalShortcutInput(nextShortcut);
    setGlobalShortcutMessage(`已录入 ${nextShortcut}，点击保存后生效。`);
  };

  const currentToolInstances = instances.filter((i) => i.toolId === activeToolId);
  const currentActiveTabId = activeTabIds[activeToolId];
  const activeToolConfig = tools.find((t) => t.id === activeToolId);
  const isSingleton = activeToolConfig?.singleton === true;
  const themeIndex = Math.max(0, THEME_OPTIONS.findIndex((option) => option.id === themeMode));

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-[var(--app-bg)] text-gray-800 font-sans relative">

      {/* 全局右键菜单浮层 */}
      {contextMenu.show && (
        <div
          className="fixed z-50 bg-white rounded-xl shadow-[0_4px_20px_-4px_rgba(0,0,0,0.15)] border border-gray-100 py-1.5 min-w-[160px] text-sm text-gray-700 animate-in fade-in zoom-in-95 duration-100 origin-top-left"
          style={{ top: contextMenu.y, left: contextMenu.x }}
        >
          <button
            className="w-full text-left px-4 py-2 hover:bg-gray-50 transition-colors"
            onClick={handleCloseOtherTabs}
          >
            关闭其他标签页
          </button>
          <div className="h-px bg-gray-100 my-1"></div>
          <button
            className="w-full text-left px-4 py-2 hover:bg-red-50 text-red-600 transition-colors"
            onClick={handleCloseAllTabs}
          >
            关闭所有标签页
          </button>
        </div>
      )}

      {/* 全局设置弹窗 */}
      {settingsOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-md overflow-hidden animate-in fade-in zoom-in-95 duration-200">
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100 bg-gray-50">
              <div>
                <h3 className="font-bold text-gray-900">设置</h3>
                <p className="text-xs text-gray-500 mt-0.5">应用基础配置</p>
              </div>
              <button
                onClick={() => setSettingsOpen(false)}
                className="p-1.5 rounded-md text-gray-400 hover:text-gray-900 hover:bg-gray-200 transition-colors"
                title="关闭"
              >
                <X size={16} />
              </button>
            </div>
            <div className="p-5 space-y-6">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <div className="text-sm font-semibold text-gray-800">开机启动</div>
                  <div className="text-xs text-gray-500 mt-1">开启后应用将在系统启动时自动运行。</div>
                  {autoStartError && (
                    <div className="text-xs text-amber-600 mt-1">{autoStartError}</div>
                  )}
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={autoStartEnabled}
                  disabled={autoStartLoading || !!autoStartError}
                  onClick={handleToggleAutostart}
                  className={`relative inline-flex h-6 w-12 items-center rounded-full transition-colors ${autoStartEnabled ? "bg-emerald-500" : "bg-gray-200"
                    } ${autoStartLoading || autoStartError ? "opacity-50 cursor-not-allowed" : "cursor-pointer"}`}
                >
                  <span
                    className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${autoStartEnabled ? "translate-x-6" : "translate-x-1"
                      }`}
                  />
                </button>
              </div>

              <div>
                <div className="text-sm font-semibold text-gray-800 mb-3">外观主题</div>
                <div className="relative bg-gray-100 rounded-full p-1">
                  <div
                    className="absolute top-1 bottom-1 left-1 rounded-full bg-blue-600 shadow-sm transition-transform duration-200"
                    style={{
                      width: "calc((100% - 0.5rem) / 3)",
                      transform: `translateX(${themeIndex * 100}%)`,
                    }}
                  />
                  <div className="relative z-10 grid grid-cols-3">
                    {THEME_OPTIONS.map((option) => (
                      <button
                        key={option.id}
                        type="button"
                        onClick={() => setThemeMode(option.id)}
                        className={`py-2 text-xs font-medium text-center transition-colors ${option.id === themeMode ? "text-white" : "text-gray-500 hover:text-gray-700"
                          }`}
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              <div>
                <div className="text-sm font-semibold text-gray-800 mb-2">快捷键呼出主界面</div>
                <div className="text-xs text-gray-500 mb-3">
                  示例：Windows 使用 Ctrl+Shift+Space，macOS 使用 Command+Shift+Space。
                </div>
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={globalShortcutInput}
                    readOnly
                    onKeyDown={handleGlobalShortcutKeyDown}
                    onFocus={() => setGlobalShortcutMessage("请直接按下快捷键组合，按 Backspace 可清空输入。")}
                    placeholder="点击这里后按下快捷键"
                    className="flex-1 px-3 py-2.5 text-sm bg-gray-50 border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all"
                  />
                  <button
                    type="button"
                    onClick={() => void handleApplyGlobalShortcut()}
                    className="px-3 py-2.5 text-sm font-medium bg-blue-600 text-white rounded-xl hover:bg-blue-700 transition-colors"
                  >
                    保存
                  </button>
                  <button
                    type="button"
                    onClick={handleClearGlobalShortcut}
                    className="px-3 py-2.5 text-sm font-medium bg-white border border-gray-200 text-gray-700 rounded-xl hover:bg-gray-50 transition-colors"
                  >
                    清除
                  </button>
                </div>
                {globalShortcutMessage && (
                  <div className="text-xs text-gray-500 mt-2">{globalShortcutMessage}</div>
                )}
                <div className="text-xs text-gray-400 mt-1">
                  快捷键会在应用后台运行时生效，用于快速呼出窗口。
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* =======================
          左侧边栏 (Sidebar) 
      ======================= */}
      <aside className="w-[260px] bg-[var(--panel-bg)] border-r border-gray-100 flex flex-col shrink-0 z-20">
        <div className="h-14 flex items-center justify-between px-6 border-b border-gray-100">
          <div className="flex items-center gap-3 cursor-pointer">
            <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center text-white font-bold text-sm shadow-sm">
              B
            </div>
            <span className="font-bold text-lg tracking-tight text-gray-900">
              bearTools
            </span>
          </div>
          <button
            onClick={() => setSettingsOpen(true)}
            className="p-2 rounded-xl text-gray-400 hover:text-gray-900 hover:bg-gray-100 transition-colors"
            title="设置"
            aria-label="打开设置"
          >
            <Settings size={18} />
          </button>
        </div>

        <nav className="flex-1 overflow-y-auto py-6 px-3">
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleMenuDragEnd}>
            <SortableContext items={tools} strategy={verticalListSortingStrategy}>
              <ul className="space-y-1">
                {tools.map((item) => (
                  <SortableNavItem
                    key={item.id}
                    item={item}
                    isActive={activeToolId === item.id}
                    onClick={handleToolClick}
                  />
                ))}
              </ul>
            </SortableContext>
          </DndContext>
        </nav>
      </aside>

      {/* =======================
          右侧工作区 (Workspace) 
      ======================= */}
      <main className="flex-1 flex flex-col min-w-0 bg-[var(--app-bg)]">
        {isSingleton && (
          <header className="h-14 flex items-center justify-between px-6 shrink-0 bg-[var(--panel-bg)] border-b border-gray-100">
            <div className="flex items-center gap-2 text-gray-800">
              {activeToolConfig && <activeToolConfig.icon size={18} className="text-gray-400" />}
              <span className="font-bold text-sm">{activeToolConfig?.name}</span>
            </div>
          </header>
        )}

        {/* 专属多标签页导航栏 (单例工具如 Agent启动 隐藏此栏) */}
        {!isSingleton && (
          <div className="h-14 bg-[var(--panel-bg)] flex flex-wrap items-end px-2 pt-2 border-b border-gray-200 shrink-0 gap-x-0 gap-y-0 select-none z-10 relative">
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleTabDragEnd}>
              <SortableContext items={currentToolInstances.map(i => i.instanceId)} strategy={rectSortingStrategy}>
                {currentToolInstances.map((inst) => (
                  <SortableTab
                    key={inst.instanceId}
                    inst={inst}
                    isActive={currentActiveTabId === inst.instanceId}
                    onClick={() => setActiveTabIds((prev) => ({ ...prev, [activeToolId]: inst.instanceId }))}
                    onClose={handleCloseTab}
                    onContextMenu={handleContextMenu}
                  />
                ))}
              </SortableContext>
            </DndContext>

            <button
              onClick={handleNewTab}
              className="ml-0.5 h-8 w-8 inline-flex items-center justify-center text-gray-500 hover:bg-white hover:text-gray-900 rounded-md transition-all border border-transparent hover:border-gray-200 active:scale-95 flex-shrink-0"
              title={`新建 ${activeToolConfig?.name} 标签页`}
            >
              <Plus size={16} />
            </button>
          </div>
        )}

        {/* 标签页内容区 */}
        <div className="flex-1 relative overflow-hidden">
          {isSingleton ? (
            // === 单例模式：直接渲染组件 ===
            <div className="absolute inset-0 z-10">
              {activeToolId === "agent-launcher" && <AgentLauncher />}
              {activeToolId === "adb" && (
                <div className="absolute inset-0 p-4 overflow-auto">
                  <AdbTool />
                </div>
              )}
            </div>
          ) : currentToolInstances.length === 0 ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center text-gray-400 gap-4">
              <div className="w-16 h-16 rounded-2xl bg-white flex items-center justify-center border border-gray-200 border-dashed shadow-sm">
                {activeToolConfig && <activeToolConfig.icon size={24} className="text-gray-300" />}
              </div>
              <div className="text-center">
                <p className="text-sm font-medium text-gray-500">当前未打开任何工作区</p>
                <button
                  onClick={handleNewTab}
                  className="mt-4 px-4 py-2 bg-white border border-gray-200 hover:bg-gray-50 text-gray-700 text-sm font-medium rounded-lg transition-colors shadow-sm inline-flex items-center gap-2"
                >
                  <Plus size={16} />
                  新建标签页
                </button>
              </div>
            </div>
          ) : (
            instances.map((inst) => {
              const isCurrentlyVisible = (inst.toolId === activeToolId) && (inst.instanceId === currentActiveTabId);
              return (
                <div
                  key={inst.instanceId}
                  className={`absolute inset-0 p-4 overflow-auto transition-opacity duration-200 ${isCurrentlyVisible ? "block opacity-100 z-10" : "hidden opacity-0 z-0"
                    }`}
                >
                  {inst.toolId === "url-encode" && <UrlTool />}
                  {inst.toolId === "json-formatter" && <JsonFormatterTool />}
                  {inst.toolId === "unix-timestamp" && <UnixTimestampTool />}
                </div>
              );
            })
          )}
        </div>

      </main>
    </div>
  );
}

export default App;
