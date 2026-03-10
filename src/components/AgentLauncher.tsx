import React, { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import {
  FolderOpen,
  Plus,
  Trash2,
  Terminal,
  Edit,
  Clock,
  X,
  Layers,
  Sparkles,
  GripVertical,
  Command as CommandIcon,
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
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

// 数据类型定义
interface AgentGroup {
  id: string;
  name: string;
}

interface AgentCommand {
  id: string;
  name: string;
  commandText: string;
}

interface AgentDirectory {
  id: string;
  alias: string;
  path: string;
  groupId: string | null;
  lastUsedAt: number;
}

const DEFAULT_COMMANDS: AgentCommand[] = [
  { id: "cmd_claude", name: "Claude", commandText: "claude" },
  { id: "cmd_codex", name: "Codex", commandText: "codex" },
  { id: "cmd_gemini", name: "Gemini", commandText: "gemini" },
  { id: "cmd_copilot", name: "Copilot", commandText: "copilot" },
  { id: "cmd_opencode", name: "OpenCode", commandText: "opencode" },
];

export default function AgentLauncher() {
  // === 状态 ===
  const [groups, setGroups] = useState<AgentGroup[]>([]);
  const [commands, setCommands] = useState<AgentCommand[]>([]);
  const [directories, setDirectories] = useState<AgentDirectory[]>([]);
  const [activeGroupId, setActiveGroupId] = useState<string | null>(null);

  const [initialized, setInitialized] = useState(false);

  // === 弹窗控制 ===
  const [dirModal, setDirModal] = useState<{ open: boolean; data: Partial<AgentDirectory> | null }>({ open: false, data: null });
  const [cmdModal, setCmdModal] = useState<{ open: boolean; data: Partial<AgentCommand> | null }>({ open: false, data: null });
  const [groupModal, setGroupModal] = useState<{ open: boolean; data: Partial<AgentGroup> | null }>({ open: false, data: null });
  
  // Settings Tab: 'directories' | 'commands' | 'groups'
  const [settingsTab, setSettingsTab] = useState<'commands' | 'groups' | null>(null);

  // === 初始化数据加载 ===
  useEffect(() => {
    const savedGroups = localStorage.getItem("agent_groups");
    const savedCommands = localStorage.getItem("agent_commands");
    const savedDirs = localStorage.getItem("agent_directories");

    if (savedGroups) setGroups(JSON.parse(savedGroups));
    else setGroups([{ id: "grp_default", name: "默认组" }]);

    if (savedCommands) setCommands(JSON.parse(savedCommands));
    else setCommands(DEFAULT_COMMANDS);

    if (savedDirs) setDirectories(JSON.parse(savedDirs));

    setInitialized(true);
  }, []);

  // === 保存数据（初始化完成后才写入）===
  useEffect(() => {
    if (initialized) localStorage.setItem("agent_groups", JSON.stringify(groups));
  }, [groups, initialized]);
  useEffect(() => {
    if (initialized) localStorage.setItem("agent_commands", JSON.stringify(commands));
  }, [commands, initialized]);
  useEffect(() => {
    if (initialized) localStorage.setItem("agent_directories", JSON.stringify(directories));
  }, [directories, initialized]);

  // === 操作 ===
  const handleOpenTerminal = async (dir: AgentDirectory, cmd: AgentCommand | null) => {
    try {
      await invoke("open_terminal_and_run", { path: dir.path, command: cmd?.commandText || "" });
      // 更新最后使用时间
      setDirectories((prev) =>
        prev.map((d) => (d.id === dir.id ? { ...d, lastUsedAt: Date.now() } : d))
      );
    } catch (error) {
      console.error("Failed to open terminal:", error);
      alert(`启动终端失败: ${error}`);
    }
  };

  const handleSelectPath = async () => {
    try {
      const selected = await open({ directory: true, multiple: false, title: "选择目录" });
      if (selected) {
        setDirModal(prev => ({ ...prev, data: { ...prev.data, path: selected as string } }));
      }
    } catch (error) {
      console.error("Failed to open directory picker:", error);
    }
  };

  const handleOpenDirectory = async (dir: AgentDirectory) => {
    if (!dir.path) {
      alert("目录路径为空，无法打开文件夹。");
      return;
    }

    try {
      await invoke("open_directory", { path: dir.path });
    } catch (error) {
      console.error("Failed to open directory in file manager:", error);
      alert(`打开文件夹失败: ${error}`);
    }
  };

  const saveDirectory = (data: Partial<AgentDirectory>) => {
    if (data.id) {
      setDirectories(prev => prev.map(d => d.id === data.id ? { ...d, ...data } as AgentDirectory : d));
    } else {
      setDirectories(prev => [...prev, {
        id: `dir_${Date.now()}`,
        alias: data.alias || '未命名',
        path: data.path || '',
        groupId: data.groupId || (groups.length > 0 ? groups[0].id : null),
        lastUsedAt: Date.now()
      }]);
    }
    setDirModal({ open: false, data: null });
  };

  const deleteDirectory = (id: string) => {
    if (confirm("确定要删除这个预设目录吗？")) {
      setDirectories(prev => prev.filter(d => d.id !== id));
    }
  };

  const saveCommand = (data: Partial<AgentCommand>) => {
    if (data.id) {
      setCommands(prev => prev.map(c => c.id === data.id ? { ...c, ...data } as AgentCommand : c));
    } else {
      setCommands(prev => [...prev, { id: `cmd_${Date.now()}`, name: data.name || '', commandText: data.commandText || '' }]);
    }
    setCmdModal({ open: false, data: null });
  };

  const saveGroup = (data: Partial<AgentGroup>) => {
    if (data.id) {
      setGroups(prev => prev.map(g => g.id === data.id ? { ...g, ...data } as AgentGroup : g));
    } else {
      setGroups(prev => [...prev, { id: `grp_${Date.now()}`, name: data.name || '' }]);
    }
    setGroupModal({ open: false, data: null });
  };

  // === 拖拽排序 ===
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  const handleCommandDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (over && active.id !== over.id) {
      setCommands((items) => {
        const oldIndex = items.findIndex((i) => i.id === active.id);
        const newIndex = items.findIndex((i) => i.id === over.id);
        return arrayMove(items, oldIndex, newIndex);
      });
    }
  };

  const handleGroupDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (over && active.id !== over.id) {
      setGroups((items) => {
        const oldIndex = items.findIndex((i) => i.id === active.id);
        const newIndex = items.findIndex((i) => i.id === over.id);
        return arrayMove(items, oldIndex, newIndex);
      });
    }
  };

  // 排序：先按最近使用降序
  const sortedDirs = [...directories].sort((a, b) => b.lastUsedAt - a.lastUsedAt);
  // 过滤：按组
  const filteredDirs = activeGroupId === null 
    ? sortedDirs 
    : sortedDirs.filter(d => d.groupId === activeGroupId);

  return (
    <div className="relative flex flex-col h-full bg-[#f8f9fc] w-full max-w-[1200px] mx-auto p-4 overflow-hidden">

      {/* 顶栏控制区 */}
      <div className="flex items-center justify-between mb-3 bg-white p-2.5 px-4 rounded-2xl shadow-sm border border-gray-100 shrink-0">
        
        {/* 左侧分组筛选 (模拟多Tab/标签样式) */}
        <div className="flex items-center gap-1 overflow-x-auto no-scrollbar">
          <button
            onClick={() => setActiveGroupId(null)}
            className={`px-4 py-2 rounded-xl text-sm font-medium transition-colors whitespace-nowrap flex items-center gap-2
              ${activeGroupId === null ? 'bg-blue-50 text-blue-600' : 'text-gray-600 hover:bg-gray-50'}`}
          >
            <Clock size={16} className={activeGroupId === null ? 'text-blue-500' : 'text-gray-400'} />
            全部 / 最近使用
          </button>
          
          <div className="w-px h-5 bg-gray-200 mx-2"></div>
          
          {groups.map(group => (
            <button
              key={group.id}
              onClick={() => setActiveGroupId(group.id)}
              className={`px-4 py-2 rounded-xl text-sm font-medium transition-colors whitespace-nowrap
                ${activeGroupId === group.id ? 'bg-blue-50 text-blue-600' : 'text-gray-600 hover:bg-gray-50'}`}
            >
              {group.name}
            </button>
          ))}
        </div>

        {/* 右侧工具/配置按钮 */}
        <div className="flex items-center gap-2 pl-4 border-l border-gray-100 shrink-0">
          <button
            onClick={() => setDirModal({ open: true, data: { groupId: activeGroupId || (groups[0]?.id || null) } })}
            className="flex items-center gap-1.5 px-3 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm font-medium rounded-xl transition-colors shadow-sm"
          >
            <Plus size={16} />
            新增目录
          </button>
          <div className="w-px h-5 bg-gray-200 mx-1"></div>
          <button
            onClick={() => setSettingsTab('commands')}
            className="p-2 text-gray-500 hover:text-gray-900 hover:bg-gray-100 rounded-xl transition-colors"
            title="指令管理"
          >
            <CommandIcon size={18} />
          </button>
          <button
            onClick={() => setSettingsTab('groups')}
            className="p-2 text-gray-500 hover:text-gray-900 hover:bg-gray-100 rounded-xl transition-colors"
            title="分组管理"
          >
            <Layers size={18} />
          </button>
        </div>
      </div>

      {/* 列表区 */}
      <div className="flex-1 overflow-y-auto no-scrollbar pb-6">
        <div className="grid grid-cols-1 gap-4">
          {filteredDirs.map((dir) => (
            <div
              key={dir.id}
              className="group bg-white rounded-2xl px-5 py-3 border border-gray-100 shadow-[0_2px_10px_-4px_rgba(0,0,0,0.05)] hover:border-blue-200 hover:shadow-md transition-all"
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    onClick={() => handleOpenDirectory(dir)}
                    className="w-10 h-10 rounded-xl bg-gradient-to-br from-blue-50 to-indigo-50 flex items-center justify-center text-blue-500 shrink-0 group-hover:scale-105 transition-transform hover:from-blue-100 hover:to-indigo-100 hover:text-blue-600 cursor-pointer"
                    title="打开该目录"
                    aria-label={`打开目录 ${dir.alias}`}
                  >
                    <FolderOpen size={20} />
                  </button>
                  <div>
                    <div className="flex items-center gap-2">
                      <h3 className="text-base font-bold text-gray-900">{dir.alias}</h3>
                      <span className="text-[11px] px-2 py-0.5 bg-gray-100 text-gray-500 rounded-md font-mono">
                        {groups.find(g => g.id === dir.groupId)?.name || '未分组'}
                      </span>
                    </div>
                    <p className="text-xs text-gray-500 mt-0.5 flex items-center gap-1.5 font-mono break-all line-clamp-1" title={dir.path}>
                      <Terminal size={12} className="opacity-60" />
                      {dir.path}
                    </p>
                  </div>
                </div>

                {/* 卡片右上角操作：编辑/删除 */}
                <div className="flex items-center opacity-0 group-hover:opacity-100 transition-opacity">
                  <button onClick={() => setDirModal({ open: true, data: dir })} className="p-1.5 text-gray-400 hover:text-blue-600 transition-colors">
                    <Edit size={14} />
                  </button>
                  <button onClick={() => deleteDirectory(dir.id)} className="p-1.5 text-gray-400 hover:text-red-500 transition-colors">
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>

              {/* 指令快捷按钮 */}
              <div className="mt-2.5 pt-2.5 border-t border-gray-50 flex flex-wrap gap-2">
                <button
                  onClick={() => handleOpenTerminal(dir, null)}
                  className="flex items-center gap-2 px-4 py-1.5 rounded-xl text-sm font-medium transition-all bg-gray-50 text-gray-700 hover:bg-gray-100 border border-gray-200 active:scale-[0.98]"
                >
                  <Terminal size={14} className="text-gray-400" />
                  终端
                </button>
                {commands.map((cmd) => (
                  <button
                    key={cmd.id}
                    onClick={() => handleOpenTerminal(dir, cmd)}
                    className="flex items-center gap-2 px-4 py-1.5 rounded-xl text-sm font-medium transition-all bg-gray-50 text-gray-700 hover:bg-gray-100 border border-gray-200 active:scale-[0.98]"
                  >
                    <Sparkles size={14} className="text-gray-400" />
                    {cmd.name}
                  </button>
                ))}
              </div>
            </div>
          ))}

          {filteredDirs.length === 0 && (
            <div className="text-center py-20 text-gray-400">
              <div className="w-16 h-16 mx-auto bg-gray-50 rounded-2xl flex items-center justify-center mb-4">
                <FolderOpen size={24} className="text-gray-300" />
              </div>
              <p>当前分组下暂无预设目录</p>
            </div>
          )}
        </div>
      </div>

      {/* ======================================================== */}
      {/*                       各 类 弹 窗                      */}
      {/* ======================================================== */}
      
      {/* 1. 新增/编辑目录 */}
      {dirModal.open && (
        <Modal title={dirModal.data?.id ? "编辑目录" : "新增目录"} onClose={() => setDirModal({ open: false, data: null })}>
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">目录别名</label>
              <input 
                type="text" 
                defaultValue={dirModal.data?.alias}
                onChange={(e) => setDirModal(prev => ({ ...prev, data: { ...prev.data, alias: e.target.value } }))}
                placeholder="例如：bearTools 前端项目" 
                className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">物理路径</label>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={dirModal.data?.path || ""}
                  onChange={(e) => setDirModal(prev => ({ ...prev, data: { ...prev.data, path: e.target.value } }))}
                  placeholder="例如：D:\claudeCode\bearTools"
                  className="flex-1 px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500"
                />
                <button
                  onClick={handleSelectPath}
                  className="px-3 py-2 bg-gray-100 hover:bg-gray-200 text-gray-600 rounded-lg text-sm transition-colors shrink-0 border border-gray-200"
                  title="选择目录"
                >
                  <FolderOpen size={16} />
                </button>
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">所属分组</label>
              <select 
                value={dirModal.data?.groupId || ""}
                onChange={(e) => setDirModal(prev => ({ ...prev, data: { ...prev.data, groupId: e.target.value } }))}
                className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500"
              >
                {groups.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
              </select>
            </div>
            <button 
              onClick={() => saveDirectory(dirModal.data || {})}
              className="w-full mt-2 py-2.5 bg-blue-600 text-white font-medium rounded-lg hover:bg-blue-700 transition-colors"
            >
              保存设置
            </button>
          </div>
        </Modal>
      )}

      {/* 2. 设置面板 (指令/分组) */}
      {settingsTab && (
        <Modal title={settingsTab === 'commands' ? "指令管理" : "分组管理"} onClose={() => setSettingsTab(null)}>
          
          {/* 切换 Tab */}
          <div className="flex border-b border-gray-100 mb-4">
            <button 
              onClick={() => setSettingsTab('commands')} 
              className={`pb-2 px-2 text-sm font-medium ${settingsTab === 'commands' ? 'border-b-2 border-blue-600 text-blue-600' : 'text-gray-500'}`}
            >
              预设指令
            </button>
            <button 
              onClick={() => setSettingsTab('groups')} 
              className={`pb-2 px-2 ml-4 text-sm font-medium ${settingsTab === 'groups' ? 'border-b-2 border-blue-600 text-blue-600' : 'text-gray-500'}`}
            >
              目录分组
            </button>
          </div>

          {/* 指令列表 */}
          {settingsTab === 'commands' && (
            <div className="space-y-2 max-h-[300px] overflow-y-auto pr-1">
              <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleCommandDragEnd}>
                <SortableContext items={commands} strategy={verticalListSortingStrategy}>
                  {commands.map(cmd => (
                    <SortableItem key={cmd.id} id={cmd.id}>
                      <div className="flex-1">
                        <div className="text-sm font-bold">{cmd.name}</div>
                        <div className="text-xs text-gray-500 font-mono">{cmd.commandText}</div>
                      </div>
                      <button onClick={() => setCmdModal({ open: true, data: cmd })} className="p-1.5 text-gray-400 hover:text-blue-600"><Edit size={14}/></button>
                      <button onClick={() => setCommands(prev => prev.filter(c => c.id !== cmd.id))} className="p-1.5 text-gray-400 hover:text-red-500"><Trash2 size={14}/></button>
                    </SortableItem>
                  ))}
                </SortableContext>
              </DndContext>
              <button onClick={() => setCmdModal({ open: true, data: null })} className="w-full py-2 border border-dashed border-gray-300 text-gray-500 rounded-lg text-sm hover:border-blue-500 hover:text-blue-600 transition-colors flex items-center justify-center gap-1 mt-2">
                <Plus size={16} /> 添加指令
              </button>
            </div>
          )}

          {/* 分组列表 */}
          {settingsTab === 'groups' && (
            <div className="space-y-2 max-h-[300px] overflow-y-auto pr-1">
              <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleGroupDragEnd}>
                <SortableContext items={groups} strategy={verticalListSortingStrategy}>
                  {groups.map(grp => (
                    <SortableItem key={grp.id} id={grp.id}>
                      <div className="flex-1 text-sm font-bold">{grp.name}</div>
                      <button onClick={() => setGroupModal({ open: true, data: grp })} className="p-1.5 text-gray-400 hover:text-blue-600"><Edit size={14}/></button>
                      {groups.length > 1 && (
                        <button onClick={() => setGroups(prev => prev.filter(g => g.id !== grp.id))} className="p-1.5 text-gray-400 hover:text-red-500"><Trash2 size={14}/></button>
                      )}
                    </SortableItem>
                  ))}
                </SortableContext>
              </DndContext>
              <button onClick={() => setGroupModal({ open: true, data: null })} className="w-full py-2 border border-dashed border-gray-300 text-gray-500 rounded-lg text-sm hover:border-blue-500 hover:text-blue-600 transition-colors flex items-center justify-center gap-1 mt-2">
                <Plus size={16} /> 添加分组
              </button>
            </div>
          )}
        </Modal>
      )}

      {/* 3. 子级弹窗 - 编辑单个指令/分组 */}
      {cmdModal.open && (
        <Modal title={cmdModal.data?.id ? "编辑指令" : "新增指令"} onClose={() => setCmdModal({ open: false, data: null })} zIndex="z-[60]">
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">显示名称</label>
              <input 
                type="text" 
                defaultValue={cmdModal.data?.name}
                onChange={(e) => setCmdModal(prev => ({ ...prev, data: { ...prev.data, name: e.target.value } }))}
                placeholder="例如：Claude" 
                className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">执行命令</label>
              <input 
                type="text" 
                defaultValue={cmdModal.data?.commandText}
                onChange={(e) => setCmdModal(prev => ({ ...prev, data: { ...prev.data, commandText: e.target.value } }))}
                placeholder="例如：claude 或者 npm run start" 
                className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 font-mono"
              />
            </div>
            <button 
              onClick={() => saveCommand(cmdModal.data || {})}
              className="w-full py-2.5 bg-blue-600 text-white font-medium rounded-lg hover:bg-blue-700 transition-colors"
            >
              保存指令
            </button>
          </div>
        </Modal>
      )}

      {groupModal.open && (
        <Modal title={groupModal.data?.id ? "编辑分组" : "新增分组"} onClose={() => setGroupModal({ open: false, data: null })} zIndex="z-[60]">
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">分组名称</label>
              <input 
                type="text" 
                defaultValue={groupModal.data?.name}
                onChange={(e) => setGroupModal(prev => ({ ...prev, data: { ...prev.data, name: e.target.value } }))}
                placeholder="例如：工作项目" 
                className="w-full px-3 py-2 bg-gray-50 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500"
              />
            </div>
            <button 
              onClick={() => saveGroup(groupModal.data || {})}
              className="w-full py-2.5 bg-blue-600 text-white font-medium rounded-lg hover:bg-blue-700 transition-colors"
            >
              保存分组
            </button>
          </div>
        </Modal>
      )}

    </div>
  );
}

// === 辅助组件：可拖拽列表项 ===
function SortableItem({ id, children }: { id: string; children: React.ReactNode }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id });

  const style = {
    transform: CSS.Translate.toString(transform),
    transition,
    zIndex: isDragging ? 50 : 0,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`flex items-center gap-2 p-2 bg-gray-50 rounded-lg border border-gray-100 ${isDragging ? "opacity-50 shadow-lg" : ""}`}
    >
      <div
        {...attributes}
        {...listeners}
        className="cursor-grab active:cursor-grabbing p-1 rounded text-gray-300 hover:text-gray-500 transition-colors"
        title="拖拽排序"
      >
        <GripVertical size={14} />
      </div>
      {children}
    </div>
  );
}

// === 辅助组件：功能区居中弹窗 ===
function Modal({ title, children, onClose, zIndex = "z-50" }: { title: string, children: React.ReactNode, onClose: () => void, zIndex?: string }) {
  return (
    <div className={`absolute inset-0 flex items-center justify-center bg-black/40 backdrop-blur-sm ${zIndex} p-4`}>
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-sm overflow-hidden animate-in fade-in zoom-in-95 duration-200">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100 bg-gray-50/50">
          <h3 className="font-bold text-gray-900">{title}</h3>
          <button onClick={onClose} className="p-1 rounded-md text-gray-400 hover:text-gray-900 hover:bg-gray-200 transition-colors">
            <X size={16} />
          </button>
        </div>
        <div className="p-5">
          {children}
        </div>
      </div>
    </div>
  );
}
