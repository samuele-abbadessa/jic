# Dashboard TUI Architecture

This document describes the architecture and key technical decisions for the JIC CLI Dashboard, a terminal-based user interface (TUI) for monitoring and managing microservices.

## Overview

The dashboard provides a real-time monitoring interface built with [blessed](https://github.com/chjj/blessed) and [blessed-contrib](https://github.com/yaronn/blessed-contrib). It features a configurable grid-based layout system, multiple panel types, and keyboard-driven navigation.

```
┌─────────────┬────────────────────────────────────────────┐
│  SIDEBAR    │           SERVICE MONITOR                  │
│  (3 cols)   │              (9 cols, 4 rows)              │
│             ├────────────────────────────────────────────┤
│  [Modules]  │                                            │
│  [Branches] │              LOG VIEWER                    │
│  [Session]  │              (9 cols, 6 rows)              │
│             │                                            │
│  Tree View  │                                            │
│             ├─────────────────────┬──────────────────────┤
│             │   INFRA STATUS      │    QUICK ACTIONS     │
│             │   (5 cols, 2 rows)  │    (4 cols, 2 rows)  │
└─────────────┴─────────────────────┴──────────────────────┘
```

## Directory Structure

```
src-ts/dashboard/
├── index.ts                    # Command registration & exports
├── Dashboard.ts                # Main controller
├── types.ts                    # Type definitions
├── layout/
│   ├── LayoutManager.ts        # Grid-based layout system
│   └── presets/
│       ├── index.ts            # Preset registry
│       ├── default.ts          # Default layout
│       ├── logs-focused.ts     # Log-focused layout
│       └── monitoring.ts       # Monitoring-focused layout
├── components/
│   ├── BasePanel.ts            # Abstract panel base class
│   ├── Sidebar.ts              # Tabbed sidebar component
│   └── panels/
│       ├── index.ts            # Panel exports
│       ├── ServiceMonitor.ts   # Service status table
│       ├── LogViewer.ts        # Log display
│       ├── InfraStatus.ts      # Infrastructure health
│       └── QuickActions.ts     # Keyboard shortcuts
└── services/
    └── DataProvider.ts         # Data fetching service
```

## Core Components

### Dashboard Controller (`Dashboard.ts`)

The main orchestrator that:
- Creates the blessed screen
- Initializes the layout manager
- Creates and manages all panels
- Handles global keyboard shortcuts
- Runs the data refresh loop (every 2 seconds)
- Manages lifecycle (start/stop)

```typescript
class Dashboard {
  private screen: Widgets.Screen;
  private layoutManager: LayoutManager;
  private dataProvider: DataProvider;
  private sidebar: Sidebar | null;
  private panels: Map<string, IPanel>;

  async start(): Promise<void>;
  stop(): void;
}
```

### Layout Manager (`LayoutManager.ts`)

Manages the configurable grid-based layout using blessed-contrib's grid system.

**Key Features:**
- 12x12 grid system (configurable)
- Sidebar support (left or right positioned)
- Automatic position adjustment for sidebar
- Widget creation at specific grid positions

```typescript
class LayoutManager {
  init(): void;
  createWidget(id, widgetType, position, options): Widgets.Node;
  createSidebarContainer(): Widgets.Node | null;
  getGrid(): Grid | null;
}
```

**Grid Type Workaround:**

blessed-contrib's TypeScript types are incomplete. We define a custom `Grid` type:

```typescript
type Grid = {
  set: (
    row: number,
    col: number,
    rowSpan: number,
    colSpan: number,
    widgetType: any,
    options?: Record<string, unknown>
  ) => Widgets.Node;
};
```

### Base Panel (`BasePanel.ts`)

Abstract base class implementing common panel functionality:

```typescript
abstract class BasePanel implements IPanel {
  readonly id: string;
  readonly type: PanelType;
  protected _widget: Widgets.Node | null;

  abstract init(): void;
  abstract update(data?: unknown): void;

  focus(): void;
  destroy(): void;
  protected startRefreshTimer(callback: () => void): void;
  protected emit(event: DashboardEvent): void;
  protected render(): void;
}
```

**Focus Styling:**
Panels change border color when focused (green) vs blurred (cyan).

### Sidebar (`Sidebar.ts`)

A tabbed navigation component containing tree views for:
1. **Modules** - Project module tree with status indicators
2. **Branches** - Git branch information per module
3. **Session** - Active session details

**Key Technical Decisions:**

1. **Tab Bar Implementation**: Uses blessed's `listbar` widget with custom command callbacks.

2. **Tree Widget**: Uses blessed-contrib's `tree` widget with proper key configuration:
   ```typescript
   // IMPORTANT: 'keys' must be an array of key strings, not a boolean
   keys: ['enter', 'space']  // Correct
   keys: true                 // WRONG - causes "key.forEach is not a function"
   ```

3. **Recursion Prevention**: Tab switching uses a guard to prevent infinite recursion:
   ```typescript
   switchTab(index: number): void {
     if (index === this.activeTabIndex && this.treeWidget) return;
     // ...
   }
   ```

### Panel Types

#### ServiceMonitor
- Displays running services in a table format
- Shows: Service name, Port, PID, Status, Uptime
- Color-coded status (green=running, red=stopped, yellow=starting)
- Keyboard shortcuts: `s` (start), `x` (stop), `r` (restart)

#### LogViewer
- Rolling log display with service-prefixed, color-coded lines
- Features: Pause/resume (`p`/`space`), Clear (`c`), Filter (`f`)
- Scroll navigation: `g` (top), `G` (bottom)

#### InfraStatus
- Infrastructure health indicators
- Shows MongoDB and Eureka connection status
- Color-coded health states

#### QuickActions
- Static keyboard shortcut reference panel

### Data Provider (`DataProvider.ts`)

Fetches data from the execution context:

```typescript
class DataProvider {
  async getServiceStatus(): Promise<ServiceStatus[]>;
  async getInfraStatus(): Promise<InfraStatus[]>;
  async getModuleTree(): Promise<ModuleTreeNode>;
  async getBranchTree(): Promise<BranchTreeNode>;
  getSessionTree(): Record<string, unknown>;
}
```

## Layout Configuration

### Layout Schema

```typescript
interface DashboardLayout {
  name: string;
  description?: string;
  grid: { rows: number; cols: number };
  sidebar?: {
    width: number;
    position: 'left' | 'right';
    tabs: SidebarTab[];
  };
  panels: PanelConfig[];
}

interface PanelConfig {
  id: string;
  type: PanelType;
  position: { row: number; col: number; rowSpan: number; colSpan: number };
  options?: {
    label?: string;
    refreshInterval?: number;
    // ...
  };
}
```

### Available Presets

| Preset | Description |
|--------|-------------|
| `default` | Balanced layout with all panels |
| `logs-focused` | Larger log viewer area |
| `monitoring` | Emphasis on service monitoring |

### Usage

```bash
jic dashboard                    # Default layout
jic dashboard -l logs-focused    # Logs-focused layout
jic dashboard --list-layouts     # List available presets
```

## Key Technical Decisions

### 1. blessed vs ink

**Decision:** Use blessed/blessed-contrib instead of ink (React-based).

**Rationale:**
- blessed-contrib provides pre-built widgets (tables, trees, logs, gauges)
- Grid-based layout system fits our configurable design
- Lower overhead than React for terminal applications
- More mature ecosystem for complex TUI layouts

**Trade-offs:**
- TypeScript types are incomplete (requires many type assertions)
- API is callback-based rather than declarative

### 2. Type Safety Approach

blessed and blessed-contrib have incomplete TypeScript definitions. Our approach:

```typescript
// Use 'any' casts with eslint-disable comments for widget creation
// eslint-disable-next-line @typescript-eslint/no-explicit-any
this.treeWidget = (contrib as any).tree({ ... });

// Use 'unknown' intermediate casts for method calls
(this.treeWidget as unknown as { setLabel: (l: string) => void }).setLabel(label);
```

### 3. Key Binding Format

**Issue:** blessed's `key()` method internally calls `keys.forEach()`, expecting an array.

**Solution:** Always pass keys as strings (blessed handles single strings):
```typescript
// Correct
widget.key('q', callback);
screen.key('escape', callback);

// Also works for arrays
widget.key(['enter', 'space'], callback);  // Only in some contexts
```

**Note for contrib.tree:** The `keys` option MUST be an array:
```typescript
contrib.tree({ keys: ['enter', 'space'] })  // Correct
contrib.tree({ keys: true })                 // WRONG
```

### 4. Event-Driven Architecture

Panels communicate with the Dashboard via events:

```typescript
type DashboardEvent =
  | { type: 'focus'; panelId: string }
  | { type: 'tab-switch'; tabId: string }
  | { type: 'service-action'; action: 'start' | 'stop' | 'restart'; service: string }
  | { type: 'refresh' }
  | { type: 'quit' };
```

### 5. Sidebar Container vs Content

**Decision:** LayoutManager creates an empty box container; Sidebar creates its own content.

**Rationale:**
- Separation of concerns: layout vs content
- Sidebar needs full control over its internal widgets (tabBar, treeWidget)
- Avoids complex widget type issues with contrib.tree in grid.set()

### 6. Auto-Refresh Strategy

- Global refresh every 2 seconds via `setInterval`
- Individual panels can have custom refresh intervals via `startRefreshTimer()`
- Log viewer uses event-driven updates (not polling)

## Keyboard Navigation

| Key | Action |
|-----|--------|
| `q` / `Esc` / `Ctrl+C` | Quit dashboard |
| `Tab` / `Shift+Tab` | Cycle between panels |
| `1` / `2` / `3` | Switch sidebar tabs |
| `R` | Force refresh all data |
| `?` | Show help overlay |
| `s` | Start selected service |
| `x` | Stop selected service |
| `r` | Restart selected service |
| `p` / `Space` | Pause/resume logs |
| `g` / `G` | Scroll to top/bottom |

## Future Enhancements

1. **Custom Layout Support** - Load layouts from `jic.config.json`
2. **Log Streaming** - Real-time log tailing from running services
3. **Process Management** - Direct service control from dashboard
4. **Search** - Search within log viewer
5. **Metrics Graphs** - CPU/memory sparklines using contrib.sparkline
6. **Persistent State** - Remember last layout and focused panel

## Dependencies

```json
{
  "blessed": "^0.1.81",
  "blessed-contrib": "^4.11.0",
  "@types/blessed": "^0.1.27"
}
```

**Note:** `@types/blessed` provides partial types. blessed-contrib has no official TypeScript definitions.
