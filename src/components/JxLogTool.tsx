import React, { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import {
  AlertCircle,
  ArrowDown,
  ArrowUp,
  CheckCircle2,
  FolderOpen,
  Play,
  Plus,
  RefreshCw,
  Save,
  Settings2,
  Terminal,
  Trash2,
  X,
} from "lucide-react";

type JxLogAction = "listModules" | "listFiles" | "downloadCurrent" | "downloadRange";
type RuntimeMode = "profile" | "mapping";
type SettingsTab = "runtime" | "profiles" | "projects" | "modules";
type TimeMode = "relative" | "absolute";

interface JxLogProfile {
  name: string;
  source: string;
  url: string;
  user: string;
  password: string;
  hosts: string[];
  path: string;
  proxy: string;
  sshHostkey: string;
}

interface JxLogEnvMapping {
  name: string;
  profile: string;
  aliases: string[];
}

interface JxLogProjectMapping {
  path: string;
  defaultEnv: string;
  envs: JxLogEnvMapping[];
}

interface JxLogConfigBundle {
  scriptRoot: string;
  configIniPath: string;
  projectMapPath: string;
  profiles: JxLogProfile[];
  projects: JxLogProjectMapping[];
}

interface JxLogRuntimeValidation {
  scriptRoot: string;
  configIniPath: string;
  projectMapPath: string;
  fetchScriptExists: boolean;
  configIniExists: boolean;
  projectMapExists: boolean;
  pythonCommand: string;
  pythonAvailable: boolean;
  pythonVersionOutput: string;
}

interface JxLogExecutionResult {
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  success: boolean;
  outputPath: string | null;
  diagnostics: {
    requestedProfile: string | null;
    resolvedProfile: string | null;
    configIniPath: string;
    projectMapPath: string;
    source: string | null;
    url: string | null;
    user: string | null;
    hosts: string[];
    path: string | null;
    requestTargets: string[];
  };
}

interface JxLogErrorBoundaryState {
  error: Error | null;
}

const STORAGE = {
  python: "jxlog_python_command",
  script: "jxlog_fetch_script_path",
  mode: "jxlog_runtime_mode",
  profile: "jxlog_selected_profile",
  project: "jxlog_selected_project",
  env: "jxlog_selected_env",
  modules: "jxlog_module_presets",
} as const;

const DEFAULT_PYTHON_COMMAND = "py";
const DEFAULT_FETCH_SCRIPT_PATH = "D:/claudeCode/jiaxinFetchLog/fetch_log.py";

const createProfile = (name = "default"): JxLogProfile => ({
  name,
  source: "portal",
  url: "https://jxprotal.aviva-cofco.com.cn/applog/",
  user: "admin",
  password: "",
  hosts: ["st", "zy"],
  path: "gw_container",
  proxy: "",
  sshHostkey: "",
});

const createProject = (): JxLogProjectMapping => ({
  path: "",
  defaultEnv: "prod",
  envs: [{ name: "prod", profile: "default", aliases: ["生产", "prod", "线上"] }],
});

const csv = {
  parse: (value: string) => value.split(",").map((item) => item.trim()).filter(Boolean),
  stringify: (value: string[]) => value.join(", "),
};

const getDir = (value: string | null) => {
  if (!value) return null;
  const normalized = value.replace(/\\/g, "/");
  return normalized.includes("/") ? normalized.replace(/\/[^/]+$/, "") || normalized : null;
};

const previewText = (value: string, maxLength = 50000) => {
  if (value.length <= maxLength) return value;
  const hiddenLength = value.length - maxLength;
  return `${value.slice(0, maxLength)}\n\n... 已截断 ${hiddenLength} 个字符，避免结果区渲染过大内容。`;
};

const toSafeText = (value: unknown, fallback = "(空)") => {
  if (typeof value === "string") {
    return value || fallback;
  }
  if (value === null || value === undefined) {
    return fallback;
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};

const sanitizeExecutionResult = (value: JxLogExecutionResult): JxLogExecutionResult => ({
  ...value,
  command: previewText(toSafeText(value.command), 4000),
  stdout: previewText(toSafeText(value.stdout)),
  stderr: previewText(toSafeText(value.stderr)),
  outputPath: value.outputPath ? previewText(toSafeText(value.outputPath), 4000) : value.outputPath,
  diagnostics: {
    ...value.diagnostics,
    configIniPath: previewText(toSafeText(value.diagnostics.configIniPath), 4000),
    projectMapPath: previewText(toSafeText(value.diagnostics.projectMapPath), 4000),
    url: value.diagnostics.url ? previewText(toSafeText(value.diagnostics.url), 4000) : null,
    path: value.diagnostics.path ? previewText(toSafeText(value.diagnostics.path), 4000) : null,
    requestedProfile: value.diagnostics.requestedProfile ? previewText(toSafeText(value.diagnostics.requestedProfile), 4000) : null,
    resolvedProfile: value.diagnostics.resolvedProfile ? previewText(toSafeText(value.diagnostics.resolvedProfile), 4000) : null,
    source: value.diagnostics.source ? previewText(toSafeText(value.diagnostics.source), 4000) : null,
    user: value.diagnostics.user ? previewText(toSafeText(value.diagnostics.user), 4000) : null,
    hosts: Array.isArray(value.diagnostics.hosts) ? value.diagnostics.hosts.map((item) => previewText(toSafeText(item), 4000)) : [],
    requestTargets: Array.isArray(value.diagnostics.requestTargets) ? value.diagnostics.requestTargets.map((item) => previewText(toSafeText(item), 4000)) : [],
  },
});

const normalizeExecutionResult = (value: unknown): JxLogExecutionResult => {
  const source = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
  return {
    command: toSafeText(source.command),
    stdout: toSafeText(source.stdout),
    stderr: toSafeText(source.stderr),
    exitCode: typeof source.exitCode === "number" ? source.exitCode : null,
    success: Boolean(source.success),
    outputPath: source.outputPath ? toSafeText(source.outputPath) : null,
    diagnostics: {
      requestedProfile: source.diagnostics && typeof source.diagnostics === "object" && source.diagnostics !== null && source.diagnostics.requestedProfile ? toSafeText((source.diagnostics as Record<string, unknown>).requestedProfile) : null,
      resolvedProfile: source.diagnostics && typeof source.diagnostics === "object" && source.diagnostics !== null && source.diagnostics.resolvedProfile ? toSafeText((source.diagnostics as Record<string, unknown>).resolvedProfile) : null,
      configIniPath: source.diagnostics && typeof source.diagnostics === "object" && source.diagnostics !== null ? toSafeText((source.diagnostics as Record<string, unknown>).configIniPath) : "(空)",
      projectMapPath: source.diagnostics && typeof source.diagnostics === "object" && source.diagnostics !== null ? toSafeText((source.diagnostics as Record<string, unknown>).projectMapPath) : "(空)",
      source: source.diagnostics && typeof source.diagnostics === "object" && source.diagnostics !== null && (source.diagnostics as Record<string, unknown>).source ? toSafeText((source.diagnostics as Record<string, unknown>).source) : null,
      url: source.diagnostics && typeof source.diagnostics === "object" && source.diagnostics !== null && (source.diagnostics as Record<string, unknown>).url ? toSafeText((source.diagnostics as Record<string, unknown>).url) : null,
      user: source.diagnostics && typeof source.diagnostics === "object" && source.diagnostics !== null && (source.diagnostics as Record<string, unknown>).user ? toSafeText((source.diagnostics as Record<string, unknown>).user) : null,
      hosts: source.diagnostics && typeof source.diagnostics === "object" && source.diagnostics !== null && Array.isArray((source.diagnostics as Record<string, unknown>).hosts)
        ? ((source.diagnostics as Record<string, unknown>).hosts as unknown[]).map((item) => toSafeText(item))
        : [],
      path: source.diagnostics && typeof source.diagnostics === "object" && source.diagnostics !== null && (source.diagnostics as Record<string, unknown>).path ? toSafeText((source.diagnostics as Record<string, unknown>).path) : null,
      requestTargets: source.diagnostics && typeof source.diagnostics === "object" && source.diagnostics !== null && Array.isArray((source.diagnostics as Record<string, unknown>).requestTargets)
        ? ((source.diagnostics as Record<string, unknown>).requestTargets as unknown[]).map((item) => toSafeText(item))
        : [],
    },
  };
};

class JxLogErrorBoundary extends React.Component<{ children: React.ReactNode }, JxLogErrorBoundaryState> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): JxLogErrorBoundaryState {
    return { error };
  }

  override render() {
    if (this.state.error) {
      return (
        <div className="m-4 rounded-3xl border border-rose-200 bg-rose-50 p-5 text-rose-700">
          <div className="font-semibold">jxLog 页面发生运行时错误</div>
          <pre className="mt-3 whitespace-pre-wrap break-words text-xs leading-6">
            {this.state.error.stack || this.state.error.message}
          </pre>
        </div>
      );
    }
    return this.props.children;
  }
}

const statusClass = (ok: boolean) =>
  ok ? "bg-emerald-50 text-emerald-700 border-emerald-200" : "bg-amber-50 text-amber-700 border-amber-200";

const SETTINGS_TABS: Array<{ id: SettingsTab; label: string }> = [
  { id: "runtime", label: "运行时路径" },
  { id: "profiles", label: "Profile 管理" },
  { id: "projects", label: "工程目录映射" },
  { id: "modules", label: "模块预设" },
];

const LOG_TYPE_OPTIONS = [
  "main",
  "sql",
  "dubbo",
  "3rdparty",
  "container",
  "hazelcast",
  "kafka",
  "redis",
  "zookeeper",
  "gc",
  "out",
  "info",
  "debug",
  "error",
  "warn",
] as const;

const DEFAULT_MODULE_OPTIONS = [
  "jiaxin_gw_oss",
  "jiaxin_gw_auth",
  "jiaxin_gw_robot",
  "jiaxin_gw_dataconf",
  "jiaxin_gw_imaccess",
  "jiaxin_gw_rest",
  "jiaxin_gw_apns",
  "jiaxin_gw_notify",
  "jiaxin_gw_ccaccess",
  "jiaxin_gw_schedule",
  "jiaxin_gw_mmp",
  "jiaxin_gw_icontek",
  "jiaxin_gw_wechatlogic",
  "jiaxin_gw_thirdparty",
  "jiaxin_gw_license",
  "jiaxin_gw_archive",
  "jiaxin_gw_wechataccess",
  "jiaxin_gw_statistics",
  "jiaxin_web_agent",
  "jiaxin_web_devcenter",
  "jiaxin_web_devmgr",
  "jiaxin_gw_order",
  "jiaxin_gw_sms",
  "jiaxin_gw_exam",
  "jiaxin_gw_cclogic",
  "jiaxin_gw_channel",
  "jiaxin_gw_msgcenter",
  "jiaxin_gw_mcs",
  "jiaxin_gw_lmsg",
  "jiaxin_gw_imlogic",
  "jiaxin_gw_validator",
  "jiaxin_gw_bill",
  "jiaxin_gw_config",
  "jiaxin_gw_crm",
  "jiaxin_gw_provision",
] as const;

const RELATIVE_TIME_OPTIONS = [
  { value: "0.5", label: "最近 30 分钟" },
  { value: "1", label: "最近 1 小时" },
  { value: "2", label: "最近 2 小时" },
  { value: "4", label: "最近 4 小时" },
  { value: "8", label: "最近 8 小时" },
  { value: "12", label: "最近 12 小时" },
  { value: "24", label: "最近 24 小时" },
] as const;

const formatDateTimeLocal = (date: Date) => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${year}-${month}-${day}T${hours}:${minutes}`;
};

const loadModulePresets = () => {
  const raw = localStorage.getItem(STORAGE.modules);
  if (!raw) {
    return [...DEFAULT_MODULE_OPTIONS];
  }
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [...DEFAULT_MODULE_OPTIONS];
    }
    const normalized = parsed.map((item) => String(item).trim()).filter(Boolean);
    return normalized.length ? normalized : [...DEFAULT_MODULE_OPTIONS];
  } catch {
    return [...DEFAULT_MODULE_OPTIONS];
  }
};

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-2">{label}</label>
      {children}
    </div>
  );
}

function Panel({ title, children }: { title?: string; children: React.ReactNode }) {
  return (
    <section className="bg-white border border-gray-100 rounded-3xl shadow-sm p-5 space-y-4">
      {title ? <div className="text-sm font-semibold text-gray-900">{title}</div> : null}
      {children}
    </section>
  );
}

function ResultBlock({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-slate-400 mb-1">{label}</div>
      <pre className="whitespace-pre-wrap break-words text-xs leading-6 bg-white/5 rounded-2xl p-3">
        {value}
      </pre>
    </div>
  );
}

function Modal({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
      <div className="bg-white rounded-3xl shadow-xl w-full max-w-[min(96vw,1200px)] h-[min(88vh,960px)] overflow-hidden flex flex-col">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100 bg-gray-50">
          <div>
            <h3 className="font-bold text-gray-900">{title}</h3>
            <p className="text-xs text-gray-500 mt-1">会直接读写 `jiaxinFetchLog` 原始配置文件。</p>
          </div>
          <button onClick={onClose} className="p-2 rounded-xl text-gray-400 hover:text-gray-900 hover:bg-gray-200 transition-colors">
            <X size={16} />
          </button>
        </div>
        <div className="p-5 flex-1 min-h-0 overflow-y-auto overflow-x-hidden">{children}</div>
      </div>
    </div>
  );
}

export default function JxLogTool() {
  return (
    <JxLogErrorBoundary>
      <JxLogToolInner />
    </JxLogErrorBoundary>
  );
}

function JxLogToolInner() {
  const [pythonCommand, setPythonCommand] = useState(localStorage.getItem(STORAGE.python) ?? DEFAULT_PYTHON_COMMAND);
  const [fetchScriptPath, setFetchScriptPath] = useState(localStorage.getItem(STORAGE.script) ?? DEFAULT_FETCH_SCRIPT_PATH);
  const [runtimeMode, setRuntimeMode] = useState<RuntimeMode>((localStorage.getItem(STORAGE.mode) as RuntimeMode) || "profile");
  const [selectedProfile, setSelectedProfile] = useState(localStorage.getItem(STORAGE.profile) ?? "");
  const [selectedProjectPath, setSelectedProjectPath] = useState(localStorage.getItem(STORAGE.project) ?? "");
  const [selectedEnvName, setSelectedEnvName] = useState(localStorage.getItem(STORAGE.env) ?? "");

  const [moduleName, setModuleName] = useState("");
  const [moduleOptions, setModuleOptions] = useState<string[]>(() => loadModulePresets());
  const [logType, setLogType] = useState("main");
  const [host, setHost] = useState("");
  const [timeMode, setTimeMode] = useState<TimeMode>("relative");
  const [relativeTimePreset, setRelativeTimePreset] = useState("1");
  const [timeValue, setTimeValue] = useState("");
  const [endValue, setEndValue] = useState("");
  const [grepValue, setGrepValue] = useState("");
  const [tailValue, setTailValue] = useState("");
  const [outputPath, setOutputPath] = useState("");

  const [runtimeValidation, setRuntimeValidation] = useState<JxLogRuntimeValidation | null>(null);
  const [configBundle, setConfigBundle] = useState<JxLogConfigBundle | null>(null);
  const [profiles, setProfiles] = useState<JxLogProfile[]>([]);
  const [projects, setProjects] = useState<JxLogProjectMapping[]>([]);
  const [result, setResult] = useState<JxLogExecutionResult | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("runtime");
  const [loadingConfig, setLoadingConfig] = useState(false);
  const [savingConfig, setSavingConfig] = useState(false);
  const [executingAction, setExecutingAction] = useState<JxLogAction | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const hasConfigChanges = useMemo(() => {
    if (!configBundle) {
      return false;
    }
    return JSON.stringify(profiles) !== JSON.stringify(configBundle.profiles)
      || JSON.stringify(projects) !== JSON.stringify(configBundle.projects);
  }, [configBundle, profiles, projects]);

  useEffect(() => { localStorage.setItem(STORAGE.python, pythonCommand); }, [pythonCommand]);
  useEffect(() => { localStorage.setItem(STORAGE.script, fetchScriptPath); }, [fetchScriptPath]);
  useEffect(() => { localStorage.setItem(STORAGE.mode, runtimeMode); }, [runtimeMode]);
  useEffect(() => { localStorage.setItem(STORAGE.profile, selectedProfile); }, [selectedProfile]);
  useEffect(() => { localStorage.setItem(STORAGE.project, selectedProjectPath); }, [selectedProjectPath]);
  useEffect(() => { localStorage.setItem(STORAGE.env, selectedEnvName); }, [selectedEnvName]);
  useEffect(() => { localStorage.setItem(STORAGE.modules, JSON.stringify(moduleOptions)); }, [moduleOptions]);

  const selectedProject = useMemo(() => projects.find((project) => project.path === selectedProjectPath) ?? null, [projects, selectedProjectPath]);
  const mappedEnv = useMemo(() => {
    if (!selectedProject) return null;
    return selectedProject.envs.find((env) => env.name === selectedEnvName)
      ?? selectedProject.envs.find((env) => env.name === selectedProject.defaultEnv)
      ?? selectedProject.envs[0]
      ?? null;
  }, [selectedEnvName, selectedProject]);
  const effectiveProfile = runtimeMode === "mapping" ? mappedEnv?.profile ?? "" : selectedProfile;
  const availableHosts = useMemo(() => {
    const profile = profiles.find((item) => item.name === effectiveProfile);
    return profile?.hosts ?? [];
  }, [effectiveProfile, profiles]);
  const quickTimeOptions = useMemo(() => RELATIVE_TIME_OPTIONS, []);

  const refreshConfiguration = async () => {
    setLoadingConfig(true);
    setBanner(null);
    setError(null);
    try {
      const validation = await invoke<JxLogRuntimeValidation>("jxlog_validate_runtime", { pythonCommand, fetchScriptPath });
      const bundle = await invoke<JxLogConfigBundle>("jxlog_load_configuration", { fetchScriptPath });
      setRuntimeValidation(validation);
      setConfigBundle(bundle);
      setProfiles(bundle.profiles.length ? bundle.profiles : [createProfile()]);
      setProjects(bundle.projects);
      if (!selectedProfile && bundle.profiles[0]) setSelectedProfile(bundle.profiles[0].name);
      if (!selectedProjectPath && bundle.projects[0]) {
        setSelectedProjectPath(bundle.projects[0].path);
        setSelectedEnvName(bundle.projects[0].defaultEnv || bundle.projects[0].envs[0]?.name || "");
      }
      setBanner("jxLog 配置已加载。");
    } catch (cause) {
      setError(String(cause));
    } finally {
      setLoadingConfig(false);
    }
  };

  useEffect(() => { void refreshConfiguration(); }, []);

  const saveConfiguration = async () => {
    setSavingConfig(true);
    setBanner(null);
    setError(null);
    try {
      const saved = await invoke<JxLogConfigBundle>("jxlog_save_configuration", { fetchScriptPath, profiles, projects });
      setConfigBundle(saved);
      setProfiles(saved.profiles);
      setProjects(saved.projects);
      setBanner("jxLog 配置已保存。");
      await refreshConfiguration();
    } catch (cause) {
      setError(String(cause));
    } finally {
      setSavingConfig(false);
    }
  };

  const executeAction = async (action: JxLogAction) => {
    if (!runtimeValidation?.fetchScriptExists) return void setError("请先确认 fetch_log.py 路径有效。");
    if (!runtimeValidation?.pythonAvailable) return void setError("Python 启动器不可用，请先修正路径。");
    if ((action === "listFiles" || action === "downloadCurrent" || action === "downloadRange") && !moduleName.trim()) return void setError("请输入模块名。");
    if (action === "downloadRange" && timeMode === "absolute" && !timeValue.trim()) return void setError("按时间拉取时必须填写起始时间。");

    setExecutingAction(action);
    setBanner(null);
    setError(null);
    try {
      const now = new Date();
      const selectedRelativeOption = quickTimeOptions.find((item) => item.value === relativeTimePreset) ?? quickTimeOptions[1];
      const effectiveRelativeHours = Number(selectedRelativeOption?.value || "1");
      const relativeStart = new Date(now.getTime() - effectiveRelativeHours * 60 * 60 * 1000);
      const requestTime = action === "downloadRange"
        ? (timeMode === "relative" ? formatDateTimeLocal(relativeStart).replace("T", " ") : timeValue.trim())
        : undefined;
      const requestEnd = action === "downloadRange"
        ? (timeMode === "relative" ? formatDateTimeLocal(now).replace("T", " ") : (endValue.trim() || formatDateTimeLocal(now).replace("T", " ")))
        : undefined;

      const rawResult = await invoke<unknown>("jxlog_execute", {
        request: {
          pythonCommand,
          fetchScriptPath,
          action,
          profile: runtimeMode === "profile" ? selectedProfile : undefined,
          projectDir: runtimeMode === "mapping" ? selectedProjectPath : undefined,
          env: runtimeMode === "mapping" ? selectedEnvName : undefined,
          module: moduleName.trim() || undefined,
          logType: logType.trim() || undefined,
          host: host.trim() || undefined,
          grep: grepValue.trim() || undefined,
          outputPath: outputPath.trim() || undefined,
          tail: tailValue.trim() ? Number(tailValue) : undefined,
          time: requestTime,
          end: requestEnd,
        },
      });
      const safeResult = sanitizeExecutionResult(normalizeExecutionResult(rawResult));
      setResult(safeResult);
      setBanner(safeResult.success ? "命令执行完成。" : "命令执行失败，请查看结果区。");
    } catch (cause) {
      setError(String(cause));
    } finally {
      setExecutingAction(null);
    }
  };

  const pickFetchScript = async () => {
    const selected = await open({ multiple: false, directory: false, filters: [{ name: "Python", extensions: ["py"] }] });
    if (selected) setFetchScriptPath(selected as string);
  };
  const pickOutputDirectory = async () => {
    const selected = await open({ multiple: false, directory: true });
    if (selected) setOutputPath(selected as string);
  };
  const pickProjectDirectory = async (index: number) => {
    const selected = await open({ multiple: false, directory: true });
    if (selected) setProjects((current) => current.map((item, i) => (i === index ? { ...item, path: selected as string } : item)));
  };
  const openResultDirectory = async () => {
    const directory = result?.outputPath ? getDir(result.outputPath) : outputPath.trim() || null;
    if (directory) await invoke("open_directory", { path: directory });
  };

  const moveModuleOption = (index: number, direction: -1 | 1) => {
    setModuleOptions((current) => {
      const nextIndex = index + direction;
      if (nextIndex < 0 || nextIndex >= current.length) {
        return current;
      }
      const next = [...current];
      const [item] = next.splice(index, 1);
      next.splice(nextIndex, 0, item);
      return next;
    });
  };

  const updateModuleOption = (index: number, value: string) => {
    setModuleOptions((current) => current.map((item, i) => (i === index ? value : item)));
  };

  const removeModuleOption = (index: number) => {
    setModuleOptions((current) => current.filter((_, i) => i !== index));
  };

  const applyRelativeTime = (hours: string) => {
    setTimeMode("relative");
    setRelativeTimePreset(hours);
    setEndValue("");
  };

  return (
    <div className={`relative h-full bg-[var(--app-bg)] ${settingsOpen ? "overflow-hidden" : "overflow-auto"}`}>
      <style>{`.field-input{padding:.75rem .875rem;border-radius:1rem;background:#f9fafb;border:1px solid #e5e7eb;font-size:.875rem;outline:none;transition:border-color .2s, box-shadow .2s}.field-input:focus{border-color:#3b82f6;box-shadow:0 0 0 4px rgba(59,130,246,.12)}`}</style>
      <div className="max-w-[1360px] mx-auto p-4 space-y-4">
        <Panel title="jxLog">
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="flex items-center gap-2 text-gray-900"><Terminal size={18} className="text-blue-600" /><span className="font-bold">jiaxinFetchLog UI</span></div>
              <p className="text-sm text-gray-500 mt-1">配置原始 profile / 项目映射，并把常用拉日志命令做成可视化操作。</p>
            </div>
            <div className="flex gap-2">
              <button onClick={() => void refreshConfiguration()} className="px-3 py-2 bg-white border border-gray-200 rounded-xl text-sm text-gray-700 hover:bg-gray-50 inline-flex items-center gap-2"><RefreshCw size={15} />{loadingConfig ? "刷新中..." : "刷新"}</button>
              <button onClick={() => setSettingsOpen(true)} className="px-3 py-2 bg-blue-600 text-white rounded-xl text-sm hover:bg-blue-700 inline-flex items-center gap-2"><Settings2 size={15} />设置</button>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <span className={`px-3 py-1.5 rounded-full text-xs font-medium border ${statusClass(!!runtimeValidation?.pythonAvailable)}`}>Python: {runtimeValidation?.pythonVersionOutput || pythonCommand}</span>
            <span className={`px-3 py-1.5 rounded-full text-xs font-medium border ${statusClass(!!runtimeValidation?.fetchScriptExists)}`}>脚本: {runtimeValidation?.fetchScriptExists ? "已找到" : "未找到"}</span>
            <span className={`px-3 py-1.5 rounded-full text-xs font-medium border ${statusClass(!!runtimeValidation?.configIniExists)}`}>INI: {runtimeValidation?.configIniExists ? "已找到" : "未创建"}</span>
            <span className={`px-3 py-1.5 rounded-full text-xs font-medium border ${statusClass(!!runtimeValidation?.projectMapExists)}`}>Map: {runtimeValidation?.projectMapExists ? "已找到" : "未创建"}</span>
            {effectiveProfile && <span className="px-3 py-1.5 rounded-full text-xs font-medium bg-blue-50 text-blue-700 border border-blue-200">当前 profile: {effectiveProfile}</span>}
          </div>
        </Panel>

        {banner && <div className="px-4 py-3 rounded-2xl bg-emerald-50 border border-emerald-200 text-emerald-700 text-sm flex items-center gap-2"><CheckCircle2 size={16} />{banner}</div>}
        {error && <div className="px-4 py-3 rounded-2xl bg-rose-50 border border-rose-200 text-rose-700 text-sm flex items-center gap-2"><AlertCircle size={16} />{error}</div>}

        <div className="grid grid-cols-1 xl:grid-cols-[1.1fr_0.9fr] gap-4">
          <Panel title="执行参数">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <Field label="运行方式">
                <div className="grid grid-cols-1 bg-gray-100 rounded-2xl p-1">
                  <button type="button" onClick={() => setRuntimeMode("profile")} className="py-2 text-sm rounded-xl bg-white text-gray-900 shadow-sm">直接选 profile</button>
                </div>
              </Field>
              <Field label="Profile"><select value={selectedProfile} onChange={(e) => setSelectedProfile(e.target.value)} className="w-full field-input"><option value="">请选择 profile</option>{profiles.map((item) => <option key={item.name} value={item.name}>{item.name} ({item.source})</option>)}</select></Field>
              <Field label="模块名">
                <select
                  value={moduleOptions.includes(moduleName) ? moduleName : ""}
                  onChange={(e) => setModuleName(e.target.value)}
                  className="w-full field-input"
                >
                  <option value="">请选择模块</option>
                  {moduleOptions.map((item) => (
                    <option key={item} value={item}>
                      {item}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="日志类型">
                <select
                  value={LOG_TYPE_OPTIONS.includes(logType as (typeof LOG_TYPE_OPTIONS)[number]) ? logType : ""}
                  onChange={(e) => setLogType(e.target.value)}
                  className="w-full field-input"
                >
                  <option value="">请选择日志类型</option>
                  {LOG_TYPE_OPTIONS.map((item) => (
                    <option key={item} value={item}>
                      {item}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="主机（可选）">
                <select value={host} onChange={(e) => setHost(e.target.value)} className="w-full field-input">
                  <option value="">全部主机</option>
                  {availableHosts.map((item) => (
                    <option key={item} value={item}>
                      {item}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="grep（可选）"><input value={grepValue} onChange={(e) => setGrepValue(e.target.value)} className="w-full field-input" placeholder="Exception|ERROR" /></Field>
              <div className="md:col-span-2">
              <Field label="时间范围">
                <div className="space-y-3">
                  <div className="grid grid-cols-2 bg-gray-100 rounded-2xl p-1">
                    <button type="button" onClick={() => setTimeMode("relative")} className={`py-2 text-sm rounded-xl ${timeMode === "relative" ? "bg-white text-gray-900 shadow-sm" : "text-gray-500"}`}>最近时间</button>
                    <button type="button" onClick={() => setTimeMode("absolute")} className={`py-2 text-sm rounded-xl ${timeMode === "absolute" ? "bg-white text-gray-900 shadow-sm" : "text-gray-500"}`}>指定时间段</button>
                  </div>
                  {timeMode === "relative" ? (
                    <div className="grid grid-cols-2 xl:grid-cols-3 gap-2">
                        {quickTimeOptions.map((option) => (
                          <button
                            key={option.value}
                            type="button"
                            onClick={() => applyRelativeTime(option.value)}
                            className={`px-3 py-2 rounded-xl text-sm border transition-colors ${relativeTimePreset === option.value ? "bg-blue-600 border-blue-600 text-white" : "bg-white border-gray-200 text-gray-700 hover:bg-gray-50"}`}
                          >
                            {option.label}
                          </button>
                        ))}
                    </div>
                  ) : (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                      <input type="datetime-local" value={timeValue} onChange={(e) => setTimeValue(e.target.value)} className="w-full field-input" />
                      <input type="datetime-local" value={endValue} onChange={(e) => setEndValue(e.target.value)} className="w-full field-input" />
                    </div>
                  )}
                </div>
              </Field>
              </div>
              <Field label="Tail"><input value={tailValue} onChange={(e) => setTailValue(e.target.value)} className="w-full field-input" placeholder="50" /></Field>
            </div>
            <Field label="输出目录（可选）">
              <div className="flex gap-2">
                <input value={outputPath} onChange={(e) => setOutputPath(e.target.value)} className="flex-1 field-input" placeholder="留空则走 jiaxinFetchLog 默认输出路径" />
                <button onClick={() => void pickOutputDirectory()} className="px-3 py-2.5 bg-white border border-gray-200 rounded-2xl text-gray-700 hover:bg-gray-50"><FolderOpen size={16} /></button>
              </div>
            </Field>
          </Panel>

          <Panel title="快捷动作与结果">
            <div className="grid grid-cols-2 gap-3">
              {[
                ["列模块", "listModules", "--list-modules"],
                ["列日志文件", "listFiles", "--list"],
                ["下载当前日志", "downloadCurrent", "--download-current"],
                ["按时间拉取", "downloadRange", "-t / -t2 / -r"],
              ].map(([label, action, detail]) => (
                <button key={action} onClick={() => void executeAction(action as JxLogAction)} disabled={executingAction === action} className="text-left rounded-2xl border border-gray-200 bg-gray-50 hover:bg-blue-50 hover:border-blue-200 transition-colors p-4 disabled:opacity-60">
                  <div className="flex items-center justify-between gap-3">
                    <div><div className="text-sm font-semibold text-gray-900">{label}</div><div className="text-xs text-gray-500 mt-1">{detail}</div></div>
                    <div className="w-10 h-10 rounded-2xl bg-white border border-gray-200 flex items-center justify-center text-blue-600"><Play size={16} /></div>
                  </div>
                </button>
              ))}
            </div>
            <div className="rounded-2xl bg-gray-50 border border-gray-200 p-4 space-y-2 text-sm">
              <div className="font-semibold text-gray-900">当前上下文摘要</div>
              <div className="flex justify-between gap-4"><span className="text-gray-500">脚本目录</span><span className="text-right break-all">{runtimeValidation?.scriptRoot || "未解析"}</span></div>
              <div className="flex justify-between gap-4"><span className="text-gray-500">配置文件</span><span className="text-right break-all">{runtimeValidation?.configIniPath || "未解析"}</span></div>
              <div className="flex justify-between gap-4"><span className="text-gray-500">映射文件</span><span className="text-right break-all">{runtimeValidation?.projectMapPath || "未解析"}</span></div>
              <div className="flex justify-between gap-4"><span className="text-gray-500">运行来源</span><span className="text-right break-all">{runtimeMode === "mapping" ? `映射到 ${effectiveProfile || "-"}` : effectiveProfile || "-"}</span></div>
            </div>
            <div className="rounded-2xl bg-slate-950 text-slate-100 p-4 min-h-[380px] flex flex-col">
              <div className="flex items-center justify-between gap-3">
                <div><div className="text-sm font-semibold">执行结果</div><div className="text-xs text-slate-400 mt-1">展示最近一次命令、stdout、stderr 和输出路径。</div></div>
                {result?.outputPath && <button onClick={() => void openResultDirectory()} className="px-3 py-2 bg-white/10 hover:bg-white/15 rounded-xl text-xs">打开输出目录</button>}
              </div>
              {result ? (
                <div className="mt-4 space-y-4 text-sm overflow-auto">
                  <ResultBlock label="命令" value={result.command || "(空)"} />
                  <ResultBlock
                    label="执行诊断"
                    value={[
                      `requestedProfile: ${result.diagnostics.requestedProfile || "-"}`,
                      `resolvedProfile: ${result.diagnostics.resolvedProfile || "-"}`,
                      `source: ${result.diagnostics.source || "-"}`,
                      `url: ${result.diagnostics.url || "-"}`,
                      `user: ${result.diagnostics.user || "-"}`,
                      `hosts: ${result.diagnostics.hosts.length ? result.diagnostics.hosts.join(", ") : "-"}`,
                      `path: ${result.diagnostics.path || "-"}`,
                      `requestTargets: ${result.diagnostics.requestTargets.length ? `\n${result.diagnostics.requestTargets.join("\n")}` : "-"}`,
                      `configIniPath: ${result.diagnostics.configIniPath || "-"}`,
                      `projectMapPath: ${result.diagnostics.projectMapPath || "-"}`,
                    ].join("\n")}
                  />
                  {result.outputPath && <ResultBlock label="输出路径" value={result.outputPath} />}
                  <ResultBlock label="stdout" value={result.stdout || "(空)"} />
                  <ResultBlock label="stderr" value={result.stderr || "(空)"} />
                </div>
              ) : (
                <div className="flex-1 flex items-center justify-center text-sm text-slate-400">还没有执行结果，先试一次“列模块”或“按时间拉取”。</div>
              )}
            </div>
          </Panel>
        </div>

        {settingsOpen && (
          <Modal title="jxLog 设置" onClose={() => setSettingsOpen(false)}>
            <div className="space-y-5">
              <div className="flex items-center justify-between gap-4 border-b border-gray-100 pb-4">
                <div className="flex flex-wrap gap-2">
                  {SETTINGS_TABS.map((tab) => (
                    <button
                      key={tab.id}
                      type="button"
                      onClick={() => setSettingsTab(tab.id)}
                      className={`px-3 py-2 rounded-xl text-sm transition-colors ${
                        settingsTab === tab.id
                          ? "bg-blue-600 text-white"
                          : "bg-white border border-gray-200 text-gray-700 hover:bg-gray-50"
                      }`}
                    >
                      {tab.label}
                    </button>
                  ))}
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {hasConfigChanges && <span className="text-xs text-amber-600">有未保存修改</span>}
                  <button onClick={() => void refreshConfiguration()} className="px-3 py-2 bg-white border border-gray-200 rounded-xl text-sm text-gray-700 hover:bg-gray-50 inline-flex items-center gap-2"><RefreshCw size={15} />{loadingConfig ? "检查中..." : "刷新"}</button>
                  <button onClick={() => void saveConfiguration()} className="px-3 py-2 bg-blue-600 text-white rounded-xl text-sm hover:bg-blue-700 inline-flex items-center gap-2"><Save size={15} />{savingConfig ? "保存中..." : "保存"}</button>
                </div>
              </div>

              {settingsTab === "runtime" && (
                <Panel title="运行时路径">
                  <Field label="Python 启动器"><input value={pythonCommand} onChange={(e) => setPythonCommand(e.target.value)} className="w-full field-input" /></Field>
                  <Field label="fetch_log.py 路径">
                    <div className="flex gap-2">
                      <input value={fetchScriptPath} onChange={(e) => setFetchScriptPath(e.target.value)} className="flex-1 field-input" />
                      <button onClick={() => void pickFetchScript()} className="px-3 py-2.5 bg-white border border-gray-200 rounded-2xl text-gray-700 hover:bg-gray-50"><FolderOpen size={16} /></button>
                    </div>
                  </Field>
                </Panel>
              )}

              {settingsTab === "profiles" && (
                <Panel>
                  <div className="flex items-center justify-between gap-3">
                    <div className="text-sm font-semibold text-gray-900">Profile 管理</div>
                    <button onClick={() => setProfiles((current) => [...current, createProfile(`profile_${current.length + 1}`)])} className="px-3 py-2 bg-white border border-gray-200 rounded-xl text-sm text-gray-700 hover:bg-gray-50 inline-flex flex-nowrap items-center gap-2 whitespace-nowrap shrink-0 min-w-fit"><Plus size={15} className="shrink-0" />新增 Profile</button>
                  </div>
                  <div className="space-y-4">
                    {profiles.map((profile, index) => (
                      <div key={`profile_${index}`} className="rounded-2xl border border-gray-200 bg-gray-50 p-4 space-y-3">
                        <div className="flex justify-between"><div className="font-semibold text-sm text-gray-900">{profile.name.trim() || "未命名 Profile"}</div><button onClick={() => setProfiles((current) => current.filter((_, i) => i !== index))} className="p-1.5 text-gray-400 hover:text-rose-600"><Trash2 size={14} /></button></div>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                          <Field label="名称"><input value={profile.name} onChange={(e) => setProfiles((current) => current.map((item, i) => i === index ? { ...item, name: e.target.value } : item))} className="w-full field-input" /></Field>
                          <Field label="Source"><select value={profile.source} onChange={(e) => setProfiles((current) => current.map((item, i) => i === index ? { ...item, source: e.target.value } : item))} className="w-full field-input"><option value="portal">portal</option><option value="ssh">ssh</option><option value="ssh_flat">ssh_flat</option></select></Field>
                          <Field label="URL"><input value={profile.url} onChange={(e) => setProfiles((current) => current.map((item, i) => i === index ? { ...item, url: e.target.value } : item))} className="w-full field-input" /></Field>
                          <Field label="用户"><input value={profile.user} onChange={(e) => setProfiles((current) => current.map((item, i) => i === index ? { ...item, user: e.target.value } : item))} className="w-full field-input" /></Field>
                          <Field label="密码"><input value={profile.password} onChange={(e) => setProfiles((current) => current.map((item, i) => i === index ? { ...item, password: e.target.value } : item))} className="w-full field-input" /></Field>
                          <Field label="Hosts"><input value={csv.stringify(profile.hosts)} onChange={(e) => setProfiles((current) => current.map((item, i) => i === index ? { ...item, hosts: csv.parse(e.target.value) } : item))} className="w-full field-input" /></Field>
                          <Field label="Path"><input value={profile.path} onChange={(e) => setProfiles((current) => current.map((item, i) => i === index ? { ...item, path: e.target.value } : item))} className="w-full field-input" placeholder={profile.source.startsWith("ssh") ? "/jiaxin/logs" : "gw_container"} /></Field>
                          <Field label="代理"><input value={profile.proxy} onChange={(e) => setProfiles((current) => current.map((item, i) => i === index ? { ...item, proxy: e.target.value } : item))} className="w-full field-input" placeholder="http://127.0.0.1:7890" /></Field>
                          {profile.source.startsWith("ssh") && <Field label="SSH Hostkey"><input value={profile.sshHostkey} onChange={(e) => setProfiles((current) => current.map((item, i) => i === index ? { ...item, sshHostkey: e.target.value } : item))} className="w-full field-input" /></Field>}
                        </div>
                      </div>
                    ))}
                  </div>
                </Panel>
              )}

              {settingsTab === "projects" && (
                <Panel>
                  <div className="flex items-center justify-between gap-3">
                    <div className="text-sm font-semibold text-gray-900">工程目录映射</div>
                    <button onClick={() => setProjects((current) => [...current, createProject()])} className="px-3 py-2 bg-white border border-gray-200 rounded-xl text-sm text-gray-700 hover:bg-gray-50 inline-flex flex-nowrap items-center gap-2 whitespace-nowrap shrink-0 min-w-fit"><Plus size={15} className="shrink-0" />新增工程</button>
                  </div>
                  <div className="space-y-4">
                    {projects.map((project, projectIndex) => (
                      <div key={`project_${projectIndex}`} className="relative rounded-2xl border border-gray-200 bg-gray-50 p-4 pb-12 space-y-3">
                        <Field label="工程目录">
                          <div className="flex gap-2">
                            <input value={project.path} onChange={(e) => setProjects((current) => current.map((item, i) => i === projectIndex ? { ...item, path: e.target.value } : item))} className="flex-1 field-input" />
                            <button onClick={() => void pickProjectDirectory(projectIndex)} className="px-3 py-2.5 bg-white border border-gray-200 rounded-2xl text-gray-700 hover:bg-gray-50"><FolderOpen size={16} /></button>
                          </div>
                        </Field>
                        <Field label="默认环境"><input value={project.defaultEnv} onChange={(e) => setProjects((current) => current.map((item, i) => i === projectIndex ? { ...item, defaultEnv: e.target.value } : item))} className="w-full field-input" /></Field>
                        <div className="space-y-3">
                          <div className="flex justify-between items-center gap-3"><div className="text-xs font-semibold uppercase tracking-wide text-gray-500">环境列表</div><button onClick={() => setProjects((current) => current.map((item, i) => i === projectIndex ? { ...item, envs: [...item.envs, { name: `env_${item.envs.length + 1}`, profile: profiles[0]?.name || "default", aliases: [] }] } : item))} className="px-2.5 py-1.5 bg-white border border-gray-200 rounded-lg text-xs text-gray-700 hover:bg-gray-50 inline-flex flex-nowrap items-center whitespace-nowrap shrink-0 min-w-fit">新增环境</button></div>
                          {project.envs.map((env, envIndex) => (
                            <div key={`project_${projectIndex}_env_${envIndex}`} className="rounded-2xl bg-white border border-gray-200 p-3 grid grid-cols-1 md:grid-cols-3 gap-3">
                              <Field label="环境名"><input value={env.name} onChange={(e) => setProjects((current) => current.map((item, i) => i === projectIndex ? { ...item, envs: item.envs.map((entry, j) => j === envIndex ? { ...entry, name: e.target.value } : entry) } : item))} className="w-full field-input" /></Field>
                              <Field label="Profile"><input value={env.profile} onChange={(e) => setProjects((current) => current.map((item, i) => i === projectIndex ? { ...item, envs: item.envs.map((entry, j) => j === envIndex ? { ...entry, profile: e.target.value } : entry) } : item))} className="w-full field-input" /></Field>
                              <Field label="别名"><input value={csv.stringify(env.aliases)} onChange={(e) => setProjects((current) => current.map((item, i) => i === projectIndex ? { ...item, envs: item.envs.map((entry, j) => j === envIndex ? { ...entry, aliases: csv.parse(e.target.value) } : entry) } : item))} className="w-full field-input" /></Field>
                              <div className="md:col-span-3 flex justify-end"><button onClick={() => setProjects((current) => current.map((item, i) => i === projectIndex ? { ...item, envs: item.envs.filter((_, j) => j !== envIndex) } : item))} className="p-1.5 text-gray-400 hover:text-rose-600"><Trash2 size={14} /></button></div>
                            </div>
                          ))}
                        </div>
                        <button onClick={() => setProjects((current) => current.filter((_, i) => i !== projectIndex))} className="absolute right-3 bottom-3 p-1.5 text-gray-400 hover:text-rose-600"><Trash2 size={14} /></button>
                      </div>
                    ))}
                  </div>
                </Panel>
              )}

              {settingsTab === "modules" && (
                <Panel>
                  <div className="flex items-center justify-between gap-3">
                    <div className="text-sm font-semibold text-gray-900">模块预设</div>
                    <div className="flex items-center gap-2">
                      <button onClick={() => setModuleOptions((current) => [...current, ""])} className="px-3 py-2 bg-white border border-gray-200 rounded-xl text-sm text-gray-700 hover:bg-gray-50 inline-flex flex-nowrap items-center gap-2 whitespace-nowrap shrink-0 min-w-fit"><Plus size={15} className="shrink-0" />新增模块</button>
                      <button onClick={() => setModuleOptions([...DEFAULT_MODULE_OPTIONS])} className="px-3 py-2 bg-white border border-gray-200 rounded-xl text-sm text-gray-700 hover:bg-gray-50 whitespace-nowrap">恢复默认</button>
                    </div>
                  </div>
                  <div className="space-y-3">
                    {moduleOptions.map((item, index) => (
                      <div key={`module_${index}`} className="grid grid-cols-[minmax(0,1fr)_auto_auto_auto] gap-2 rounded-2xl border border-gray-200 bg-gray-50 p-3">
                        <input value={item} onChange={(e) => updateModuleOption(index, e.target.value)} className="w-full field-input" placeholder="模块名" />
                        <button onClick={() => moveModuleOption(index, -1)} disabled={index === 0} className="px-3 py-2 bg-white border border-gray-200 rounded-xl text-gray-700 hover:bg-gray-50 disabled:opacity-40"><ArrowUp size={14} /></button>
                        <button onClick={() => moveModuleOption(index, 1)} disabled={index === moduleOptions.length - 1} className="px-3 py-2 bg-white border border-gray-200 rounded-xl text-gray-700 hover:bg-gray-50 disabled:opacity-40"><ArrowDown size={14} /></button>
                        <button onClick={() => removeModuleOption(index)} className="px-3 py-2 bg-white border border-gray-200 rounded-xl text-gray-700 hover:text-rose-600 hover:bg-rose-50"><Trash2 size={14} /></button>
                      </div>
                    ))}
                  </div>
                </Panel>
              )}
            </div>
          </Modal>
        )}
      </div>
    </div>
  );
}
