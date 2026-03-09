import React, { useState, useEffect } from "react";
import {
  Smartphone,
  Link as LinkIcon,
  Play,
  Copy,
  Trash2,
  GripVertical,
  X,
  Plus,
  Bot,
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
import AgentLauncher from "./components/AgentLauncher";

// =======================
// 配置区：工具注册表
// =======================
const INITIAL_TOOLS = [
  { id: "agent-launcher", name: "Agent 启动", icon: Bot, singleton: true },
  { id: "adb", name: "ADB WiFi 配对", icon: Smartphone },
  { id: "url-encode", name: "URL 编解码", icon: LinkIcon },
];

const generateInstanceId = () => `inst_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;

interface ToolInstance {
  instanceId: string;
  toolId: string;
  title: string;
}

// =======================
// 独立工具组件
// =======================
function AdbTool() {
  return (
    <div className="grid grid-cols-1 xl:grid-cols-2 gap-6 h-full">
      <div className="bg-white p-4 rounded-2xl border border-gray-100 shadow-[0_2px_10px_-4px_rgba(0,0,0,0.05)] h-fit">
        <div className="flex items-center gap-3 mb-6">
          <div className="w-10 h-10 rounded-xl bg-blue-50 flex items-center justify-center text-blue-500">
            <Smartphone size={20} />
          </div>
          <div>
            <h2 className="text-lg font-bold text-gray-900">连接设备</h2>
            <p className="text-sm text-gray-500 mt-0.5">输入无线调试的 IP 与配对码</p>
          </div>
        </div>
        <div className="space-y-5">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">IP 地址与端口</label>
            <input
              type="text"
              placeholder="例: 192.168.1.100:37000"
              className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all placeholder:text-gray-400"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">配对码</label>
            <input
              type="text"
              placeholder="6 位配对码"
              className="w-full px-4 py-2.5 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all placeholder:text-gray-400"
            />
          </div>
          <div className="pt-2">
            <button className="w-full flex items-center justify-center gap-2 px-4 py-3 bg-blue-600 hover:bg-blue-700 text-white font-medium rounded-xl transition-all shadow-sm shadow-blue-500/20 active:scale-[0.98]">
              <Play size={16} />
              开始配对与连接
            </button>
          </div>
        </div>
      </div>

      <div className="bg-[#1e1e1e] p-6 rounded-2xl shadow-sm flex flex-col h-full min-h-[400px]">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-bold text-gray-300 flex items-center gap-2">
            <div className="w-2 h-2 rounded-full bg-green-500"></div>
            控制台输出
          </h3>
          <button className="text-gray-500 hover:text-gray-300 transition-colors">
            <Trash2 size={16} />
          </button>
        </div>
        <div className="flex-1 bg-[#141414] rounded-xl border border-gray-800 p-4 font-mono text-xs text-gray-400 overflow-y-auto">
          <p className="text-gray-600 mb-2">{">"} 等待执行指令...</p>
        </div>
      </div>
    </div>
  );
}

function UrlTool() {
  return (
    <div className="bg-white p-6 md:p-8 rounded-2xl border border-gray-100 shadow-[0_2px_10px_-4px_rgba(0,0,0,0.05)] h-full flex flex-col max-w-4xl">
      <div className="flex items-center gap-3 mb-6">
        <div className="w-10 h-10 rounded-xl bg-purple-50 flex items-center justify-center text-purple-500">
          <LinkIcon size={20} />
        </div>
        <div>
          <h2 className="text-lg font-bold text-gray-900">文本输入</h2>
          <p className="text-sm text-gray-500 mt-0.5">在下方输入需要进行转换的内容</p>
        </div>
      </div>

      <textarea
        placeholder="输入或粘贴内容..."
        className="w-full flex-1 min-h-[200px] p-4 bg-gray-50 border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-purple-500/20 focus:border-purple-500 transition-all placeholder:text-gray-400 resize-none mb-6"
      ></textarea>

      <div className="flex flex-wrap items-center gap-4">
        <button className="flex items-center gap-2 px-6 py-2.5 bg-purple-600 text-white font-medium rounded-xl hover:bg-purple-700 transition-all shadow-sm shadow-purple-500/20 active:scale-[0.98]">
          URL 编码
        </button>
        <button className="flex items-center gap-2 px-6 py-2.5 bg-white border border-gray-200 text-gray-700 font-medium rounded-xl hover:bg-gray-50 transition-all shadow-sm active:scale-[0.98]">
          URL 解码
        </button>
        <div className="flex-1"></div>
        <button className="flex items-center gap-2 px-4 py-2.5 text-gray-500 hover:text-gray-700 font-medium rounded-xl hover:bg-gray-100 transition-colors">
          <Copy size={16} />
          复制结果
        </button>
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
    { instanceId: "inst_init_adb", toolId: "adb", title: "ADB WiFi 配对" }
  ]);
  const [activeTabIds, setActiveTabIds] = useState<Record<string, string>>({
    "agent-launcher": "inst_init_agent",
    adb: "inst_init_adb"
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
    const hasInstances = instances.some((i) => i.toolId === toolId);
    if (!hasInstances) {
      const toolConfig = tools.find((t) => t.id === toolId);
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
            // === 单例模式：直接渲染组件 ===
            <div className="absolute inset-0 z-10">
              {activeToolId === "agent-launcher" && <AgentLauncher />}
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
                  className={`absolute inset-0 p-4 overflow-auto transition-opacity duration-200 ${
                    isCurrentlyVisible ? "block opacity-100 z-10" : "hidden opacity-0 z-0"
                  }`}
                >
                  {inst.toolId === "adb" && <AdbTool />}
                  {inst.toolId === "url-encode" && <UrlTool />}
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
