import React, { useState, useEffect, useRef } from "react";
import {
  Smartphone,
  Link as LinkIcon,
  Clock3,
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
import AgentLauncher from "./components/AgentLauncher";

// =======================
// 配置区：工具注册表
// =======================
const INITIAL_TOOLS = [
  { id: "agent-launcher", name: "Agent 启动", icon: Bot, singleton: true },
  { id: "adb", name: "ADB WiFi 配对", icon: Smartphone, singleton: true },
  { id: "url-encode", name: "URL 编解码", icon: LinkIcon },
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

type AdbFlowStep = "idle" | "checking" | "existing-devices" | "pair" | "connect" | "done";

type IpOctets = [string, string, string, string];

interface SegmentedAddressValue {
  octets: IpOctets;
  port: string;
}

const MAX_PAIRING_CODE_DIGITS = 6;
const PAIR_ADDRESS_STORAGE_KEY = "adb_last_pair_address";
const CONNECT_ADDRESS_STORAGE_KEY = "adb_last_connect_address";

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
  // 初始状态为 idle，等待用户手动点击检查设备
  const [step, setStep] = useState<AdbFlowStep>("idle");
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

  // 不再自动检查设备，改为手动触发

  const handleResetFlow = () => {
    setPairAddress(parseStoredAddress(PAIR_ADDRESS_STORAGE_KEY));
    setConnectAddress(parseStoredAddress(CONNECT_ADDRESS_STORAGE_KEY));
    setPairingCode(Array.from({ length: MAX_PAIRING_CODE_DIGITS }, () => ""));
    setExistingDevices([]);
    setCheckError(null);
    setLastConnectedSerial(null);
    resetConsole("> 流程已重置，请点击'开始检查设备'继续...");
    setStep("idle");
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
        setStep("idle");
      }
    }

    if (step === "existing-devices") {
      setStep("idle");
    }

    if (step === "checking") {
      setStep("idle");
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

  const canGoBack = step === "checking" || step === "existing-devices" || step === "pair" || step === "connect" || step === "done";

  const renderStepPanel = () => {
    if (step === "idle") {
      return (
        <div className="bg-white p-6 rounded-2xl border border-gray-100 shadow-[0_2px_10px_-4px_rgba(0,0,0,0.05)]">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-emerald-50 to-teal-50 flex items-center justify-center text-emerald-500">
              <Smartphone size={18} />
            </div>
            <div>
              <h2 className="text-lg font-bold text-gray-900">ADB WiFi 配对</h2>
              <p className="text-sm text-gray-500 mt-0.5">通过 WiFi 无线连接 Android 设备进行调试</p>
            </div>
          </div>
          <div className="space-y-4">
            <div className="rounded-xl border border-gray-100 bg-gray-50 px-4 py-3 text-sm text-gray-600">
              <p className="font-medium text-gray-700 mb-2">使用前请确保：</p>
              <ul className="space-y-1.5 list-disc list-inside text-gray-600">
                <li>手机已通过 USB 连接电脑</li>
                <li>手机已开启开发者选项和 USB 调试</li>
                <li>电脑已安装 ADB 驱动（Windows）</li>
              </ul>
            </div>
            <button
              type="button"
              onClick={() => void checkDevices({ resetLogs: true })}
              disabled={isCheckingDevices}
              className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 bg-emerald-600 hover:bg-emerald-700 disabled:bg-emerald-400 text-white font-medium rounded-xl transition-all"
            >
              <Smartphone size={16} />
              {isCheckingDevices ? "正在检查设备..." : "开始检查设备"}
            </button>
          </div>
        </div>
      );
    }

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
            <button
              type="submit"
              disabled={isPairing || isConnecting}
              className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 disabled:cursor-not-allowed text-white font-medium rounded-xl transition-all shadow-sm shadow-blue-500/20 active:scale-[0.98]"
            >
              <Play size={16} />
              {isPairing ? "正在执行 adb pair..." : "执行 adb pair"}
            </button>
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
                {step === "idle" && " 准备"}
                {step === "checking" && " 检查设备"}
                {step === "existing-devices" && " 已连接设备确认"}
                {step === "pair" && " 配对"}
                {step === "connect" && " 连接"}
                {step === "done" && " 完成"}
              </p>
            </div>
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
              className={`whitespace-pre-wrap break-all ${
                line.type === "command"
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
        className={`flex-1 rounded-lg text-sm font-medium transition-colors ${
          value === "seconds" ? "bg-blue-50 text-blue-600" : "text-gray-500 hover:text-gray-700"
        }`}
      >
        秒
      </button>
      <button
        type="button"
        onClick={() => onChange("milliseconds")}
        className={`flex-1 rounded-lg text-sm font-medium transition-colors ${
          value === "milliseconds" ? "bg-blue-50 text-blue-600" : "text-gray-500 hover:text-gray-700"
        }`}
      >
        毫秒
      </button>
    </div>
  );

  return (
    <div className="max-w-6xl">
      <div className="bg-white rounded-2xl border border-gray-100 shadow-[0_2px_10px_-4px_rgba(0,0,0,0.05)] p-6 md:p-8 space-y-8">
        <div className="flex flex-col gap-4 rounded-2xl bg-slate-50 border border-slate-100 p-5">
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
          <div className="rounded-2xl border border-gray-100 bg-gray-50/70 p-4">
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

          <div className="rounded-2xl border border-gray-100 bg-gray-50/70 p-4">
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

          <div className="rounded-2xl border border-gray-100 bg-gray-50/70 p-4">
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
        className={`w-full flex items-center p-1 rounded-xl transition-all duration-200 group ${
          isActive
            ? "bg-blue-50 text-blue-600 font-medium"
            : "text-gray-500 hover:bg-gray-50 hover:text-gray-900"
        }`}
      >
        <div
          {...attributes}
          {...listeners}
          className="cursor-grab active:cursor-grabbing p-1.5 mr-1 rounded-md text-gray-300 hover:text-gray-500 hover:bg-gray-200/50 transition-colors opacity-0 group-hover:opacity-100"
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
      className={`group relative flex items-center gap-2 px-3 h-9 min-w-[130px] max-w-[220px] rounded-t-xl cursor-pointer transition-all select-none border border-b-0 ${
        isActive
          ? "bg-white border-gray-300 text-blue-700 font-medium shadow-[0_2px_8px_-6px_rgba(0,0,0,0.25)]"
          : "bg-gray-100 border-gray-200 text-gray-600 hover:bg-gray-50"
      } ${isDragging ? "opacity-50" : "opacity-100"} ${
        isActive ? "z-10 -mb-[1px]" : "z-0"
      }`}
    >
      <span className="truncate flex-1 text-xs select-none pointer-events-none">{inst.title}</span>
      <button
        onClick={(e) => {
          e.stopPropagation();
          onClose(e, inst.instanceId);
        }}
        onPointerDown={(e) => e.stopPropagation()}
          className={`p-1 rounded-md transition-colors ${
            isActive
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

  const currentToolInstances = instances.filter((i) => i.toolId === activeToolId);
  const currentActiveTabId = activeTabIds[activeToolId];
  const activeToolConfig = tools.find((t) => t.id === activeToolId);
  const isSingleton = activeToolConfig?.singleton === true;

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-white text-gray-800 font-sans relative">
      
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

      {/* =======================
          左侧边栏 (Sidebar) 
      ======================= */}
      <aside className="w-[260px] bg-white border-r border-gray-100 flex flex-col shrink-0 z-20">
        <div className="h-16 flex items-center px-6 border-b border-gray-50/50">
          <div className="flex items-center gap-3 cursor-pointer">
            <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center text-white font-bold text-sm shadow-sm">
              B
            </div>
            <span className="font-bold text-lg tracking-tight text-gray-900">
              bearTools
            </span>
          </div>
        </div>

        <nav className="flex-1 overflow-y-auto py-6 px-3">
          <div className="text-[11px] font-semibold text-gray-400 mb-3 px-4 uppercase tracking-wider">
            工具库
          </div>

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
      <main className="flex-1 flex flex-col min-w-0 bg-[#f8f9fc]">
        
        {/* 工具上下文头部 */}
        <header className="h-14 flex items-center justify-between px-6 shrink-0 bg-white border-b border-gray-100">
          <div className="flex items-center gap-2 text-gray-800">
            {activeToolConfig && <activeToolConfig.icon size={18} className="text-gray-400" />}
            <span className="font-bold text-sm">{activeToolConfig?.name}</span>
          </div>
        </header>

        {/* 专属多标签页导航栏 (单例工具如 Agent启动 隐藏此栏) */}
        {!isSingleton && (
          <div className="bg-[#f1f3f4] flex flex-wrap items-end px-2 pt-2 border-b border-gray-200 shrink-0 gap-x-0 gap-y-0 select-none z-10 relative">
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
            // === 单例模式：使用 hidden 保活组件状态 ===
            <>
              <div className={`absolute inset-0 z-10 ${activeToolId === "agent-launcher" ? 'block' : 'hidden'}`}>
                <AgentLauncher />
              </div>
              <div className={`absolute inset-0 z-10 ${activeToolId === "adb" ? 'block' : 'hidden'}`}>
                <div className="absolute inset-0 p-4 overflow-auto">
                  <AdbTool />
                </div>
              </div>
            </>
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
            currentToolInstances.map((inst) => (
              <div
                key={inst.instanceId}
                className={`absolute inset-0 ${currentActiveTabId === inst.instanceId ? 'block' : 'hidden'}`}
              >
                {activeToolId === "url-encode" && <UrlTool />}
                {activeToolId === "unix-timestamp" && <UnixTimestampTool />}
              </div>
            ))
          )}
        </div>

      </main>
    </div>
  );
}

export default App;
