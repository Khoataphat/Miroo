export class NavBar {
    private static instance?: NavBar;
    private readonly headerElement: HTMLElement;
    private readonly counterText: HTMLElement;
    private readonly counterDot: HTMLElement;
    private readonly refreshBtn: HTMLButtonElement;
    private readonly themeToggleBtn: HTMLButtonElement;
    private isRefreshing = false;

    public static getInstance(): NavBar {
        if (!this.instance) {
            this.instance = new NavBar();
        }
        return this.instance;
    }

    public static init(): NavBar {
        return this.getInstance();
    }

    public static onRefreshHandler?: () => void;

    public static updateCounts(): void {
        if (!this.instance) {
            return;
        }
        const devices = document.querySelectorAll('#devices .device');
        const activeDevices = document.querySelectorAll('#devices .device.active');
        this.instance.updateDeviceCount(activeDevices.length, devices.length);
        this.instance.updateEmptyState(devices.length === 0);
    }

    private constructor() {
        const header = document.createElement('header');
        header.id = 'miroo-navbar';
        header.className = 'miroo-navbar';
        header.innerHTML = `
            <div class="navbar-inner">
                <div class="navbar-brand">
                    <div class="brand-logo-wrap">
                        <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="brand-glyph">
                            <rect x="5" y="2" width="14" height="20" rx="3" ry="3"></rect>
                            <line x1="12" y1="18" x2="12.01" y2="18"></line>
                        </svg>
                        <span class="brand-cast-icon">
                            <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                                <path d="M2 16.1A5 5 0 0 1 5.9 20M2 12.05A9 9 0 0 1 9.95 20M2 8V6a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-6"></path>
                                <line x1="2" y1="20" x2="2.01" y2="20"></line>
                            </svg>
                        </span>
                    </div>
                    <div class="brand-meta">
                        <span class="brand-name">Miroo</span>
                        <span class="brand-tag">Screen Mirror</span>
                    </div>
                </div>

                <div class="navbar-center">
                    <div id="device-counter-badge" class="device-counter-badge">
                        <span id="counter-dot" class="counter-dot counter-offline"></span>
                        <span id="device-counter-text" class="counter-text">0 thiết bị kết nối</span>
                    </div>
                </div>

                <div class="navbar-actions">
                    <button id="btn-refresh-adb" class="navbar-btn refresh-btn" type="button" title="Quét lại thiết bị ADB">
                        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" class="btn-icon refresh-svg">
                            <polyline points="23 4 23 10 17 10"></polyline>
                            <polyline points="1 20 1 14 7 14"></polyline>
                            <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path>
                        </svg>
                        <span class="btn-label">Quét lại thiết bị</span>
                    </button>

                    <button id="btn-theme-toggle" class="navbar-btn theme-toggle-btn" type="button" title="Chuyển chế độ Sáng / Tối" aria-label="Toggle Dark/Light Mode">
                        <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="theme-icon icon-sun">
                            <circle cx="12" cy="12" r="5"></circle>
                            <line x1="12" y1="1" x2="12" y2="3"></line>
                            <line x1="12" y1="21" x2="12" y2="23"></line>
                            <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line>
                            <line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line>
                            <line x1="1" y1="12" x2="3" y2="12"></line>
                            <line x1="21" y1="12" x2="23" y2="12"></line>
                            <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line>
                            <line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line>
                        </svg>
                        <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="theme-icon icon-moon">
                            <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path>
                        </svg>
                    </button>
                </div>
            </div>
        `;

        this.headerElement = header;
        this.counterText = header.querySelector('#device-counter-text') as HTMLElement;
        this.counterDot = header.querySelector('#counter-dot') as HTMLElement;
        this.refreshBtn = header.querySelector('#btn-refresh-adb') as HTMLButtonElement;
        this.themeToggleBtn = header.querySelector('#btn-theme-toggle') as HTMLButtonElement;

        // Insert at the very top of document.body
        if (document.body.firstChild) {
            document.body.insertBefore(header, document.body.firstChild);
        } else {
            document.body.appendChild(header);
        }

        // Initialize theme
        this.initTheme();

        // Event listeners
        this.refreshBtn.addEventListener('click', this.onRefreshClick);
        this.themeToggleBtn.addEventListener('click', this.onThemeToggleClick);
    }

    private initTheme(): void {
        const savedTheme = localStorage.getItem('miroo-theme');
        let theme = savedTheme;
        if (!theme) {
            const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
            theme = prefersDark ? 'dark' : 'light';
        }
        this.applyTheme(theme);
    }

    private applyTheme(theme: string): void {
        document.documentElement.setAttribute('data-theme', theme);
        document.body.setAttribute('data-theme', theme);
        if (theme === 'dark') {
            document.body.classList.add('theme-dark');
            document.body.classList.remove('theme-light');
        } else {
            document.body.classList.add('theme-light');
            document.body.classList.remove('theme-dark');
        }
    }

    private onThemeToggleClick = (): void => {
        const currentTheme = document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
        const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
        this.applyTheme(newTheme);
        localStorage.setItem('miroo-theme', newTheme);
    };

    public triggerRefresh(): void {
        this.onRefreshClick();
    }

    private onRefreshClick = (): void => {
        if (this.isRefreshing) {
            return;
        }
        this.isRefreshing = true;
        this.refreshBtn.classList.add('refreshing');
        const btnLabel = this.refreshBtn.querySelector('.btn-label');
        if (btnLabel) {
            btnLabel.textContent = 'Đang quét...';
        }

        // Trigger registered full ADB refresh
        if (NavBar.onRefreshHandler) {
            try {
                NavBar.onRefreshHandler();
            } catch (e) {
                console.error('[NavBar] Refresh error:', e);
            }
        }

        // Trigger UPDATE_INTERFACES on all active devices
        const updateButtons = document.querySelectorAll<HTMLButtonElement>(
            '#devices button.update-interfaces-button.active',
        );
        updateButtons.forEach((btn) => {
            try {
                btn.click();
            } catch (e) {
                // ignore
            }
        });

        setTimeout(() => {
            if (btnLabel) {
                btnLabel.textContent = 'Đã quét xong!';
            }
            this.refreshBtn.classList.remove('refreshing');
            NavBar.updateCounts();
            setTimeout(() => {
                if (btnLabel) {
                    btnLabel.textContent = 'Quét lại thiết bị';
                }
                this.isRefreshing = false;
            }, 1000);
        }, 800);
    };

    public updateEmptyState(isEmpty: boolean): void {
        const holder = document.getElementById('devices');
        if (!holder) {
            return;
        }
        const emptyEl = holder.querySelector('.empty-devices-state');
        if (isEmpty) {
            if (!emptyEl) {
                const el = document.createElement('div');
                el.className = 'empty-devices-state';
                el.innerHTML = `
                    <div class="empty-icon-wrap">
                        <svg viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="currentColor" stroke-width="1.5">
                            <rect x="5" y="2" width="14" height="20" rx="3" ry="3"></rect>
                            <line x1="12" y1="18" x2="12.01" y2="18"></line>
                        </svg>
                    </div>
                    <h3 class="empty-title">Chưa có thiết bị nào kết nối</h3>
                    <p class="empty-desc">Kết nối điện thoại Android qua cáp USB và bật <b>Gỡ lỗi USB (USB Debugging)</b>, hoặc kết nối không dây qua <code>adb connect &lt;ip&gt;:5555</code>.</p>
                    <div class="empty-actions">
                        <button class="empty-refresh-btn" type="button">
                            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2">
                                <polyline points="23 4 23 10 17 10"></polyline>
                                <polyline points="1 20 1 14 7 14"></polyline>
                                <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path>
                            </svg>
                            <span>Quét lại thiết bị</span>
                        </button>
                    </div>
                `;
                const refreshBtn = el.querySelector<HTMLButtonElement>('.empty-refresh-btn');
                if (refreshBtn) {
                    refreshBtn.onclick = () => {
                        this.triggerRefresh();
                    };
                }
                holder.appendChild(el);
            }
        } else if (emptyEl) {
            emptyEl.remove();
        }
    }

    public updateDeviceCount(activeCount: number, totalCount: number): void {
        this.counterDot.className = 'counter-dot';
        if (totalCount === 0) {
            this.counterText.innerText = '0 thiết bị kết nối';
            this.counterDot.classList.add('counter-offline');
        } else if (activeCount > 0) {
            this.counterText.innerText =
                activeCount === 1 ? '1 thiết bị đã kết nối' : `${activeCount} thiết bị đã kết nối`;
            this.counterDot.classList.add('counter-online', 'pulsating');
        } else {
            this.counterText.innerText =
                totalCount === 1 ? '1 thiết bị (ngoại tuyến)' : `${totalCount} thiết bị (ngoại tuyến)`;
            this.counterDot.classList.add('counter-idle');
        }
    }

    public getHeaderElement(): HTMLElement {
        return this.headerElement;
    }
}
