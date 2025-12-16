/**
 * Sidebar Component
 *
 * Manages the tabbed sidebar with tree views for modules, branches, and session.
 */

import type { Widgets } from 'blessed';
import blessed from 'blessed';
import contrib from 'blessed-contrib';
import type {
  SidebarConfig,
  SidebarTab,
  ModuleTreeNode,
  BranchTreeNode,
  DashboardEventHandler,
} from '../types.js';

// ============================================================================
// Sidebar Class
// ============================================================================

export class Sidebar {
  private screen: Widgets.Screen;
  private config: SidebarConfig;
  private container: Widgets.BoxElement;
  private tabBar: Widgets.ListbarElement | null = null;
  private treeWidget: ReturnType<typeof contrib.tree> | null = null;
  private activeTabIndex: number = -1; // -1 means no tab selected yet
  private eventHandler?: DashboardEventHandler;

  // Data caches
  private moduleData: ModuleTreeNode = { name: 'root', children: {} };
  private branchData: BranchTreeNode = { name: 'root', children: {} };
  private sessionData: Record<string, unknown> = {};

  constructor(
    screen: Widgets.Screen,
    container: Widgets.BoxElement,
    config: SidebarConfig,
    eventHandler?: DashboardEventHandler
  ) {
    this.screen = screen;
    this.container = container;
    this.config = config;
    this.eventHandler = eventHandler;
  }

  /**
   * Initialize the sidebar
   */
  init(): void {
    this.createTabBar();
    this.createTreeWidget();
    this.setupKeyBindings();
    this.switchTab(0);
  }

  /**
   * Create the tab bar at the top of the sidebar
   */
  private createTabBar(): void {
    const commands: Record<string, () => void> = {};

    this.config.tabs.forEach((tab, index) => {
      const label = tab.icon ? `${tab.icon} ${tab.label}` : tab.label;
      commands[label] = () => this.switchTab(index);
    });

    // Note: blessed types are incomplete, using type assertion
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.tabBar = blessed.listbar({
      parent: this.container,
      top: 0,
      left: 0,
      right: 0,
      height: 3,
      mouse: true,
      keys: true,
      autoCommandKeys: false,
      commands: commands,
      style: {
        bg: 'black',
        item: {
          bg: 'black',
          fg: 'white',
        },
        selected: {
          bg: 'cyan',
          fg: 'black',
        },
      },
    } as any);
  }

  /**
   * Create the tree widget below the tab bar
   */
  private createTreeWidget(): void {
    // Use blessed box as base since contrib.tree types are incomplete
    // Note: contrib.tree expects `keys` to be an array of key strings, not a boolean
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.treeWidget = (contrib as any).tree({
      parent: this.container,
      top: 3,
      left: 0,
      right: 0,
      bottom: 0,
      fg: 'white',
      selectedFg: 'black',
      selectedBg: 'cyan',
      mouse: true,
      keys: ['enter', 'space'],  // Toggle keys for tree nodes
      label: ' Modules ',
      border: { type: 'line' },
      style: {
        border: { fg: 'cyan' },
        selected: {
          fg: 'black',
          bg: 'cyan',
        },
      },
    }) as ReturnType<typeof contrib.tree>;

    // Handle tree selection
    (this.treeWidget as unknown as { on: (event: string, handler: (node: { name: string }) => void) => void }).on('select', (node: { name: string }) => {
      if (node && this.eventHandler) {
        const currentTab = this.config.tabs[this.activeTabIndex];
        if (currentTab?.panel === 'module-tree') {
          this.eventHandler({
            type: 'focus',
            panelId: `module:${node.name}`,
          });
        }
      }
    });
  }

  /**
   * Setup keyboard shortcuts
   */
  private setupKeyBindings(): void {
    // Tab switching with number keys
    this.config.tabs.forEach((_, index) => {
      this.container.key(`${index + 1}`, () => {
        this.switchTab(index);
      });
    });

    // Tab/Shift+Tab to cycle tabs
    this.container.key('tab', () => {
      this.switchTab((this.activeTabIndex + 1) % this.config.tabs.length);
    });

    this.container.key('S-tab', () => {
      this.switchTab(
        (this.activeTabIndex - 1 + this.config.tabs.length) % this.config.tabs.length
      );
    });
  }

  /**
   * Switch to a specific tab
   */
  switchTab(index: number): void {
    if (index < 0 || index >= this.config.tabs.length) return;
    // Prevent recursive calls - only update if the tab actually changed
    if (index === this.activeTabIndex && this.treeWidget) return;

    this.activeTabIndex = index;
    const tab = this.config.tabs[index];

    // Update tab bar selection (select method doesn't trigger callbacks)
    if (this.tabBar) {
      (this.tabBar as unknown as { select: (i: number) => void }).select(index);
    }

    // Update tree label and data
    if (this.treeWidget) {
      (this.treeWidget as unknown as { setLabel: (l: string) => void }).setLabel(
        ` ${tab.label} `
      );

      switch (tab.panel) {
        case 'module-tree':
          this.showModuleTree();
          break;
        case 'branch-tree':
          this.showBranchTree();
          break;
        case 'session-info':
          this.showSessionTree();
          break;
      }
    }

    this.eventHandler?.({ type: 'tab-switch', tabId: tab.id });
    this.screen.render();
  }

  /**
   * Show module tree
   */
  private showModuleTree(): void {
    if (!this.treeWidget) return;

    this.treeWidget.setData({
      extended: true,
      children: this.moduleData.children ?? {},
    });
  }

  /**
   * Show branch tree
   */
  private showBranchTree(): void {
    if (!this.treeWidget) return;

    this.treeWidget.setData({
      extended: true,
      children: this.branchData.children ?? {},
    });
  }

  /**
   * Show session info as tree
   */
  private showSessionTree(): void {
    if (!this.treeWidget) return;

    // Cast to any to work around incomplete type definitions
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (this.treeWidget as any).setData({
      extended: true,
      children: this.sessionData,
    });
  }

  /**
   * Update module data
   */
  updateModules(data: ModuleTreeNode): void {
    this.moduleData = data;
    if (this.config.tabs[this.activeTabIndex]?.panel === 'module-tree') {
      this.showModuleTree();
      this.screen.render();
    }
  }

  /**
   * Update branch data
   */
  updateBranches(data: BranchTreeNode): void {
    this.branchData = data;
    if (this.config.tabs[this.activeTabIndex]?.panel === 'branch-tree') {
      this.showBranchTree();
      this.screen.render();
    }
  }

  /**
   * Update session data
   */
  updateSession(data: Record<string, unknown>): void {
    this.sessionData = data;
    if (this.config.tabs[this.activeTabIndex]?.panel === 'session-info') {
      this.showSessionTree();
      this.screen.render();
    }
  }

  /**
   * Focus the sidebar
   */
  focus(): void {
    this.treeWidget?.focus();
  }

  /**
   * Get the active tab
   */
  getActiveTab(): SidebarTab | undefined {
    return this.config.tabs[this.activeTabIndex];
  }

  /**
   * Destroy and cleanup
   */
  destroy(): void {
    this.tabBar?.destroy();
    this.treeWidget?.destroy();
  }
}
