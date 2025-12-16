/**
 * Dashboard Controller
 *
 * Main controller for the TUI dashboard. Orchestrates layout, panels, and data updates.
 */

import blessed from 'blessed';
import contrib from 'blessed-contrib';
import type { Widgets } from 'blessed';
import type { IExecutionContext } from '../core/context/ExecutionContext.js';
import type {
  DashboardState,
  DashboardEvent,
  PanelConfig,
  IPanel,
} from './types.js';
import { LayoutManager } from './layout/LayoutManager.js';
import { Sidebar } from './components/Sidebar.js';
import { DataProvider } from './services/DataProvider.js';
import {
  ServiceMonitorPanel,
  getServiceMonitorWidgetOptions,
  LogViewerPanel,
  getLogViewerWidgetOptions,
  InfraStatusPanel,
  getInfraStatusWidgetOptions,
  QuickActionsPanel,
  getQuickActionsWidgetOptions,
} from './components/panels/index.js';
import { defaultLayout } from './layout/presets/default.js';
import { getLayoutPreset } from './layout/presets/index.js';

// ============================================================================
// Dashboard Class
// ============================================================================

export class Dashboard {
  private ctx: IExecutionContext;
  private screen: Widgets.Screen;
  private layoutManager: LayoutManager;
  private dataProvider: DataProvider;
  private sidebar: Sidebar | null = null;
  private panels: Map<string, IPanel> = new Map();
  private state: DashboardState;
  private refreshTimer?: ReturnType<typeof setInterval>;

  constructor(ctx: IExecutionContext, layoutName?: string) {
    this.ctx = ctx;
    this.dataProvider = new DataProvider(ctx);

    // Get layout
    const layout = layoutName ? getLayoutPreset(layoutName) ?? defaultLayout : defaultLayout;

    // Create screen
    this.screen = blessed.screen({
      smartCSR: true,
      mouse: true,
      autoPadding: true,
      fullUnicode: true,
      title: 'JIC Dashboard',
    });

    // Create layout manager
    this.layoutManager = new LayoutManager(this.screen, layout);

    // Initialize state
    this.state = {
      logsPaused: false,
      lastRefresh: new Date(),
    };
  }

  /**
   * Initialize and start the dashboard
   */
  async start(): Promise<void> {
    // Initialize layout
    this.layoutManager.init();

    // Create sidebar
    this.createSidebar();

    // Create panels
    await this.createPanels();

    // Setup keyboard shortcuts
    this.setupKeyBindings();

    // Start data refresh loop
    this.startRefreshLoop();

    // Initial data load
    await this.refreshAllData();

    // Render
    this.screen.render();
  }

  /**
   * Create the sidebar
   */
  private createSidebar(): void {
    const sidebarConfig = this.layoutManager.getSidebarConfig();
    if (!sidebarConfig) return;

    const container = this.layoutManager.createSidebarContainer();
    if (!container) return;

    this.sidebar = new Sidebar(
      this.screen,
      container as Widgets.BoxElement,
      sidebarConfig,
      (event) => this.handleEvent(event)
    );

    this.sidebar.init();
  }

  /**
   * Create all panels based on layout configuration
   */
  private async createPanels(): Promise<void> {
    const panelConfigs = this.layoutManager.getPanelConfigs();
    const grid = this.layoutManager.getGrid();

    if (!grid) return;

    for (const config of panelConfigs) {
      const panel = await this.createPanel(config);
      if (panel) {
        this.panels.set(config.id, panel);
      }
    }
  }

  /**
   * Create a single panel
   */
  private async createPanel(config: PanelConfig): Promise<IPanel | null> {
    const grid = this.layoutManager.getGrid();
    if (!grid) return null;

    const eventHandler = (event: DashboardEvent) => this.handleEvent(event);
    const label = config.options?.label ?? config.id;

    let panel: IPanel;
    let widgetType: unknown;
    let widgetOptions: Record<string, unknown>;

    switch (config.type) {
      case 'service-monitor':
        widgetType = contrib.table;
        widgetOptions = getServiceMonitorWidgetOptions(label);
        panel = new ServiceMonitorPanel(config, eventHandler);
        break;

      case 'log-viewer':
        widgetType = contrib.log;
        widgetOptions = getLogViewerWidgetOptions(label);
        panel = new LogViewerPanel(config, eventHandler);
        break;

      case 'infra-status':
        widgetType = contrib.table;
        widgetOptions = getInfraStatusWidgetOptions(label);
        panel = new InfraStatusPanel(config, eventHandler);
        break;

      case 'quick-actions':
        widgetType = blessed.box;
        widgetOptions = getQuickActionsWidgetOptions(label);
        panel = new QuickActionsPanel(config, eventHandler);
        break;

      default:
        return null;
    }

    // Create widget using layout manager
    const widget = this.layoutManager.createWidget(
      config.id,
      widgetType as typeof contrib.log,
      config.position,
      widgetOptions
    );

    // Set widget on panel
    panel.setWidget(widget);
    panel.init();

    // Register with layout manager
    this.layoutManager.registerWidget(config.id, widget, config);

    return panel;
  }

  /**
   * Setup global keyboard shortcuts
   */
  private setupKeyBindings(): void {
    // Quit
    this.screen.key('q', () => this.stop());
    this.screen.key('C-c', () => this.stop());
    this.screen.key('escape', () => this.stop());

    // Tab navigation
    this.screen.key('tab', () => this.focusNextPanel());
    this.screen.key('S-tab', () => this.focusPreviousPanel());

    // Refresh all
    this.screen.key('R', async () => {
      await this.refreshAllData();
    });

    // Help overlay
    this.screen.key('?', () => this.showHelp());

    // Focus sidebar - number keys
    for (let i = 1; i <= 3; i++) {
      this.screen.key(`${i}`, () => {
        const tabIndex = i - 1;
        this.sidebar?.switchTab(tabIndex);
        this.sidebar?.focus();
      });
    }
  }

  /**
   * Start the data refresh loop
   */
  private startRefreshLoop(): void {
    this.refreshTimer = setInterval(async () => {
      await this.refreshAllData();
    }, 2000);
  }

  /**
   * Refresh all panel data
   */
  private async refreshAllData(): Promise<void> {
    this.state.lastRefresh = new Date();

    // Update service monitor
    const servicePanel = this.panels.get('services') as ServiceMonitorPanel | undefined;
    if (servicePanel) {
      const services = await this.dataProvider.getServiceStatus();
      servicePanel.update(services);
    }

    // Update infrastructure status
    const infraPanel = this.panels.get('infra') as InfraStatusPanel | undefined;
    if (infraPanel) {
      const infra = await this.dataProvider.getInfraStatus();
      infraPanel.update(infra);
    }

    // Update sidebar trees
    if (this.sidebar) {
      const moduleTree = await this.dataProvider.getModuleTree();
      this.sidebar.updateModules(moduleTree);

      const branchTree = await this.dataProvider.getBranchTree();
      this.sidebar.updateBranches(branchTree);

      const sessionTree = this.dataProvider.getSessionTree();
      this.sidebar.updateSession(sessionTree);
    }

    this.screen.render();
  }

  /**
   * Handle dashboard events
   */
  private async handleEvent(event: DashboardEvent): Promise<void> {
    switch (event.type) {
      case 'service-action':
        await this.handleServiceAction(event.action, event.service);
        break;

      case 'refresh':
        await this.refreshAllData();
        break;

      case 'quit':
        this.stop();
        break;

      case 'focus':
        // Handle focus event
        break;

      case 'tab-switch':
        // Handle tab switch
        break;
    }
  }

  /**
   * Handle service actions (start/stop/restart)
   */
  private async handleServiceAction(
    action: 'start' | 'stop' | 'restart',
    serviceName: string
  ): Promise<void> {
    // Find the module
    const module = this.ctx.getModule(serviceName);
    if (!module) return;

    // Show status message
    const message = blessed.message({
      parent: this.screen,
      top: 'center',
      left: 'center',
      width: 40,
      height: 5,
      border: 'line',
      style: {
        border: { fg: 'cyan' },
      },
    });

    message.display(`${action}ing ${serviceName}...`, 0, () => {
      // Action would be performed here
      // For now, just refresh data
      this.refreshAllData();
    });

    this.screen.render();
  }

  /**
   * Focus the next panel
   */
  private focusNextPanel(): void {
    const panelIds = Array.from(this.panels.keys());
    const currentIndex = panelIds.indexOf(this.state.focusedPanel ?? '');
    const nextIndex = (currentIndex + 1) % panelIds.length;
    const nextPanelId = panelIds[nextIndex];

    if (nextPanelId) {
      this.state.focusedPanel = nextPanelId;
      this.panels.get(nextPanelId)?.focus();
    }
  }

  /**
   * Focus the previous panel
   */
  private focusPreviousPanel(): void {
    const panelIds = Array.from(this.panels.keys());
    const currentIndex = panelIds.indexOf(this.state.focusedPanel ?? '');
    const prevIndex = (currentIndex - 1 + panelIds.length) % panelIds.length;
    const prevPanelId = panelIds[prevIndex];

    if (prevPanelId) {
      this.state.focusedPanel = prevPanelId;
      this.panels.get(prevPanelId)?.focus();
    }
  }

  /**
   * Show help overlay
   */
  private showHelp(): void {
    const helpBox = blessed.box({
      parent: this.screen,
      top: 'center',
      left: 'center',
      width: 50,
      height: 18,
      tags: true,
      border: { type: 'line' },
      style: {
        border: { fg: 'cyan' },
        bg: 'black',
      },
      label: ' Help ',
      content: `
{cyan-fg}Keyboard Shortcuts{/cyan-fg}

{bold}Navigation{/bold}
  Tab / S-Tab    Next/Prev panel
  1-3            Switch sidebar tab
  j/k            Scroll down/up
  g/G            Top/Bottom

{bold}Actions{/bold}
  s              Start service
  x              Stop service
  r              Restart service
  R              Refresh all data
  p              Pause logs

{bold}Other{/bold}
  ?              Show help
  q / Esc        Quit

{gray-fg}Press any key to close{/gray-fg}
      `,
    });

    const closeHelp = () => {
      helpBox.destroy();
      this.screen.render();
    };
    helpBox.key('escape', closeHelp);
    helpBox.key('q', closeHelp);
    helpBox.key('enter', closeHelp);
    helpBox.key('space', closeHelp);

    helpBox.focus();
    this.screen.render();
  }

  /**
   * Stop the dashboard
   */
  stop(): void {
    // Stop refresh timer
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
    }

    // Destroy all panels
    for (const panel of this.panels.values()) {
      panel.destroy();
    }

    // Destroy sidebar
    this.sidebar?.destroy();

    // Destroy layout
    this.layoutManager.destroy();

    // Destroy screen
    this.screen.destroy();

    // Exit process
    process.exit(0);
  }
}
