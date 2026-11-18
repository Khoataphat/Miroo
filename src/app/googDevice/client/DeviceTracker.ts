import '../../../style/devicelist.css';
import { BaseDeviceTracker } from '../../client/BaseDeviceTracker';
import { SERVER_PORT } from '../../../common/Constants';
import { ACTION } from '../../../common/Action';
import GoogDeviceDescriptor from '../../../types/GoogDeviceDescriptor';
import { ControlCenterCommand } from '../../../common/ControlCenterCommand';
import { StreamClientScrcpy } from './StreamClientScrcpy';
import SvgImage from '../../ui/SvgImage';
import { html } from '../../ui/HtmlTag';
import Util from '../../Util';
import { Attribute } from '../../Attribute';
import { DeviceState } from '../../../common/DeviceState';
import { Message } from '../../../types/Message';
import { ParamsDeviceTracker } from '../../../types/ParamsDeviceTracker';
import { HostItem } from '../../../types/Configuration';
import { ChannelCode } from '../../../common/ChannelCode';
import { Tool } from '../../client/Tool';

type Field = keyof GoogDeviceDescriptor | ((descriptor: GoogDeviceDescriptor) => string);
type DescriptionColumn = { title: string; field: Field };

const DESC_COLUMNS: DescriptionColumn[] = [
    {
        title: 'Net Interface',
        field: 'interfaces',
    },
    {
        title: 'Server PID',
        field: 'pid',
    },
];

export class DeviceTracker extends BaseDeviceTracker<GoogDeviceDescriptor, never> {
    public static readonly ACTION = ACTION.GOOG_DEVICE_LIST;
    public static readonly CREATE_DIRECT_LINKS = true;
    private static instancesByUrl: Map<string, DeviceTracker> = new Map();
    protected static tools: Set<Tool> = new Set();
    protected tableId = 'goog_device_list';

    public static start(hostItem: HostItem): DeviceTracker {
        const url = this.buildUrlForTracker(hostItem).toString();
        let instance = this.instancesByUrl.get(url);
        if (!instance) {
            instance = new DeviceTracker(hostItem, url);
        }
        return instance;
    }

    public static getInstance(hostItem: HostItem): DeviceTracker {
        return this.start(hostItem);
    }

    protected constructor(params: HostItem, directUrl: string) {
        super({ ...params, action: DeviceTracker.ACTION }, directUrl);
        DeviceTracker.instancesByUrl.set(directUrl, this);
        this.buildDeviceTable();
        this.openNewConnection();
    }

    protected onSocketOpen(): void {
        // nothing here;
    }

    protected setIdAndHostName(id: string, hostName: string): void {
        super.setIdAndHostName(id, hostName);
        for (const value of DeviceTracker.instancesByUrl.values()) {
            if (value.id === id && value !== this) {
                console.warn(
                    `Tracker with url: "${this.url}" has the same id(${this.id}) as tracker with url "${value.url}"`,
                );
                console.warn(`This tracker will shut down`);
                this.destroy();
            }
        }
    }

    onInterfaceSelected = (event: Event): void => {
        const selectElement = event.currentTarget as HTMLSelectElement;
        const option = selectElement.selectedOptions[0];
        const url = decodeURI(option.getAttribute(Attribute.URL) || '');
        const name = option.getAttribute(Attribute.NAME) || '';
        const fullName = decodeURIComponent(selectElement.getAttribute(Attribute.FULL_NAME) || '');
        const udid = selectElement.getAttribute(Attribute.UDID) || '';
        this.updateLink({ url, name, fullName, udid, store: true });
    };

    private updateLink(params: { url: string; name: string; fullName: string; udid: string; store: boolean }): void {
        const { url, name, fullName, udid, store } = params;
        const playerTds = document.getElementsByName(
            encodeURIComponent(`${DeviceTracker.AttributePrefixPlayerFor}${fullName}`),
        );
        if (typeof udid !== 'string') {
            return;
        }
        if (store) {
            const localStorageKey = DeviceTracker.getLocalStorageKey(fullName || '');
            if (localStorage && name) {
                localStorage.setItem(localStorageKey, name);
            }
        }
        const action = ACTION.STREAM_SCRCPY;
        playerTds.forEach((item) => {
            item.innerHTML = '';
            const playerFullName = item.getAttribute(DeviceTracker.AttributePlayerFullName);
            const playerCodeName = item.getAttribute(DeviceTracker.AttributePlayerCodeName);
            if (!playerFullName || !playerCodeName) {
                return;
            }
            const link = DeviceTracker.buildLink(
                {
                    action,
                    udid,
                    player: decodeURIComponent(playerCodeName),
                    ws: url,
                    fitToScreen: false,
                },
                decodeURIComponent(playerFullName),
                this.params,
            );
            item.appendChild(link);
        });

        const quickConnectBtn = document.getElementById(`quick_connect_${fullName}`) as HTMLAnchorElement | null;
        if (quickConnectBtn) {
            const players = StreamClientScrcpy.getPlayers();
            const recommended =
                players.find((p) => p.playerCodeName.toLowerCase() === 'webcodecs') ||
                players.find((p) => p.playerCodeName.toLowerCase() === 'mse') ||
                players[0];
            if (recommended) {
                const link = DeviceTracker.buildLink(
                    {
                        action,
                        udid,
                        player: decodeURIComponent(recommended.playerCodeName),
                        ws: url,
                        fitToScreen: false,
                    },
                    '',
                    this.params,
                );
                quickConnectBtn.href = link.href;
                quickConnectBtn.classList.remove('disabled');
                quickConnectBtn.title = `Bắt đầu điều khiển qua ${recommended.playerFullName}`;
                const qcText = quickConnectBtn.querySelector('.qc-btn-text');
                if (qcText) {
                    qcText.textContent = 'Bắt đầu điều khiển';
                }
            }
        }
    }

    onActionButtonClick = (event: MouseEvent): void => {
        const button = event.currentTarget as HTMLButtonElement;
        const udid = button.getAttribute(Attribute.UDID);
        const pidString = button.getAttribute(Attribute.PID) || '';
        const command = button.getAttribute(Attribute.COMMAND) as string;
        const pid = parseInt(pidString, 10);
        const data: Message = {
            id: this.getNextId(),
            type: command,
            data: {
                udid: typeof udid === 'string' ? udid : undefined,
                pid: isNaN(pid) ? undefined : pid,
            },
        };

        if (this.ws && this.ws.readyState === this.ws.OPEN) {
            this.ws.send(JSON.stringify(data));
        }
    };

    public sendStartServer(udid: string): void {
        const data: Message = {
            id: this.getNextId(),
            type: ControlCenterCommand.START_SERVER,
            data: { udid },
        };
        if (this.ws && this.ws.readyState === this.ws.OPEN) {
            this.ws.send(JSON.stringify(data));
        }
    }

    private static getLocalStorageKey(udid: string): string {
        return `device_list::${udid}::interface`;
    }

    protected static createUrl(params: ParamsDeviceTracker, udid = ''): URL {
        const secure = !!params.secure;
        const hostname = params.hostname || location.hostname;
        const port = typeof params.port === 'number' ? params.port : secure ? 443 : 80;
        const pathname = params.pathname || location.pathname;
        const urlObject = this.buildUrl({ ...params, secure, hostname, port, pathname });
        if (udid) {
            urlObject.searchParams.set('action', ACTION.PROXY_ADB);
            urlObject.searchParams.set('remote', `tcp:${SERVER_PORT.toString(10)}`);
            urlObject.searchParams.set('udid', udid);
        }
        return urlObject;
    }

    protected static createInterfaceOption(name: string, url: string): HTMLOptionElement {
        const optionElement = document.createElement('option');
        optionElement.setAttribute(Attribute.URL, url);
        optionElement.setAttribute(Attribute.NAME, name);
        optionElement.innerText = `proxy over adb`;
        return optionElement;
    }

    private static titleToClassName(title: string): string {
        return title.toLowerCase().replace(/\s/g, '_');
    }

    protected buildDeviceRow(tbody: Element, device: GoogDeviceDescriptor): void {
        let selectedInterfaceUrl = '';
        let selectedInterfaceName = '';
        const blockClass = 'desc-block';
        const fullName = `${this.id}_${Util.escapeUdid(device.udid)}`;
        const isActive = device.state === DeviceState.DEVICE;
        let hasPid = false;
        const servicesId = `device_services_${fullName}`;
        const quickConnectId = `quick_connect_${fullName}`;
        const toolsGroupId = `tools_container_${fullName}`;
        const playersGroupId = `players_container_${fullName}`;
        const infraGroupId = `infra_container_${fullName}`;

        const brand = (device['ro.product.manufacturer'] || '').trim();
        const model = (device['ro.product.model'] || '').trim();
        const displayName = brand || model ? `${brand} ${model}`.trim() : 'Thiết bị Android';
        const release = device['ro.build.version.release'] || 'N/A';
        const sdk = device['ro.build.version.sdk'] || 'N/A';
        const abi = device['ro.product.cpu.abi'] || '';

        const row = html`<div class="device ${isActive ? 'active' : 'not-active'}" id="device_${fullName}">
            <div class="device-card-inner">
                <div class="device-header">
                    <div class="device-icon-box">
                        <svg
                            viewBox="0 0 24 24"
                            width="24"
                            height="24"
                            fill="none"
                            stroke="currentColor"
                            stroke-width="1.8"
                            stroke-linecap="round"
                            stroke-linejoin="round"
                            class="device-glyph"
                        >
                            <rect x="5" y="2" width="14" height="20" rx="3" ry="3"></rect>
                            <line x1="12" y1="18" x2="12.01" y2="18"></line>
                        </svg>
                    </div>
                    <div class="device-title-area">
                        <div class="device-name-row">
                            <span class="device-name" title="${displayName}">${displayName}</span>
                        </div>
                        <div class="device-serial-row">
                            <span class="device-serial" title="${device.udid}">${device.udid}</span>
                        </div>
                    </div>
                    <div
                        class="device-status-badge ${isActive ? 'online' : 'offline'}"
                        title="Trạng thái: ${device.state}"
                    >
                        <span class="status-pulse-dot"></span>
                        <span class="status-label-text">${isActive ? 'Online' : device.state}</span>
                    </div>
                    <div class="device-state" title="State: ${device.state}" style="display:none;"></div>
                </div>

                <div class="device-specs-bar">
                    <div class="spec-pill os-pill">
                        <span class="spec-label">Android</span>
                        <span class="release-version spec-value">${release}</span>
                    </div>
                    <div class="spec-pill sdk-pill">
                        <span class="spec-label">SDK</span>
                        <span class="sdk-version spec-value">${sdk}</span>
                    </div>
                    <div class="spec-pill abi-pill" style="${abi ? '' : 'display: none;'}">
                        <span class="spec-label">CPU</span>
                        <span class="spec-value">${abi}</span>
                    </div>
                </div>

                <div class="device-primary-action">
                    <a
                        id="${quickConnectId}"
                        class="btn-quick-connect ${isActive ? '' : 'disabled'}"
                        target="_blank"
                        rel="noopener noreferrer"
                        title="Bắt đầu điều khiển"
                    >
                        <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" class="play-icon">
                            <polygon points="5 3 19 12 5 21 5 3"></polygon>
                        </svg>
                        <span class="qc-btn-text">Bắt đầu điều khiển</span>
                    </a>
                </div>

                <details class="device-advanced-panel">
                    <summary class="advanced-summary">
                        <span class="summary-left">
                            <svg
                                viewBox="0 0 24 24"
                                width="15"
                                height="15"
                                fill="none"
                                stroke="currentColor"
                                stroke-width="2"
                                stroke-linecap="round"
                                stroke-linejoin="round"
                                class="adv-icon"
                            >
                                <circle cx="12" cy="12" r="3"></circle>
                                <path
                                    d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"
                                ></path>
                            </svg>
                            Tuỳ chọn nâng cao
                        </span>
                        <svg
                            viewBox="0 0 24 24"
                            width="16"
                            height="16"
                            fill="none"
                            stroke="currentColor"
                            stroke-width="2"
                            class="chevron-icon"
                        >
                            <polyline points="6 9 12 15 18 9"></polyline>
                        </svg>
                    </summary>
                    <div class="advanced-body">
                        <div class="adv-group-section">
                            <div class="adv-group-header">Công cụ quản lý</div>
                            <div id="${toolsGroupId}" class="adv-group-items tools-grid"></div>
                        </div>

                        <div class="adv-group-section">
                            <div class="adv-group-header">Trình phát (Players)</div>
                            <div id="${playersGroupId}" class="adv-group-items players-grid"></div>
                        </div>

                        <div class="adv-group-section">
                            <div class="adv-group-header">Hạ tầng & Kết nối</div>
                            <div id="${infraGroupId}" class="adv-group-items infra-grid"></div>
                        </div>
                    </div>
                </details>

                <div id="${servicesId}" class="services" style="display:none;"></div>
            </div>
        </div>`.content;

        const toolsContainer = row.getElementById(toolsGroupId);
        const playersContainer = row.getElementById(playersGroupId);
        const infraContainer = row.getElementById(infraGroupId);
        const quickConnectBtn = row.getElementById(quickConnectId) as HTMLAnchorElement | null;

        if (toolsContainer) {
            DeviceTracker.tools.forEach((tool) => {
                const entry = tool.createEntryForDeviceList(device, blockClass, this.params);
                if (entry) {
                    if (Array.isArray(entry)) {
                        entry.forEach((item) => {
                            item && toolsContainer.appendChild(item);
                        });
                    } else {
                        toolsContainer.appendChild(entry);
                    }
                }
            });

            const streamEntry = StreamClientScrcpy.createEntryForDeviceList(device, blockClass, fullName, this.params);
            streamEntry && toolsContainer.appendChild(streamEntry);
        }

        DESC_COLUMNS.forEach((item) => {
            const { title } = item;
            const fieldName = item.field;
            let value: string;
            if (typeof item.field === 'string') {
                value = '' + device[item.field];
            } else {
                value = item.field(device);
            }
            const td = document.createElement('div');
            td.classList.add(DeviceTracker.titleToClassName(title), blockClass);
            if (infraContainer) {
                infraContainer.appendChild(td);
            }
            if (fieldName === 'pid') {
                hasPid = value !== '-1';
                const actionButton = document.createElement('button');
                actionButton.className = 'action-button kill-server-button';
                actionButton.setAttribute(Attribute.UDID, device.udid);
                actionButton.setAttribute(Attribute.PID, value);
                let command: string;
                if (isActive) {
                    actionButton.classList.add('active');
                    actionButton.onclick = this.onActionButtonClick;
                    if (hasPid) {
                        command = ControlCenterCommand.KILL_SERVER;
                        actionButton.title = 'Kill server';
                        actionButton.appendChild(SvgImage.create(SvgImage.Icon.CANCEL));
                    } else {
                        command = ControlCenterCommand.START_SERVER;
                        actionButton.title = 'Start server';
                        actionButton.appendChild(SvgImage.create(SvgImage.Icon.REFRESH));
                    }
                    actionButton.setAttribute(Attribute.COMMAND, command);
                } else {
                    const timestamp = device['last.update.timestamp'];
                    if (timestamp) {
                        const date = new Date(timestamp);
                        actionButton.title = `Last update on ${date.toLocaleDateString()} at ${date.toLocaleTimeString()}`;
                    } else {
                        actionButton.title = `Not active`;
                    }
                    actionButton.appendChild(SvgImage.create(SvgImage.Icon.OFFLINE));
                }
                const span = document.createElement('span');
                span.innerText = `PID: ${value}`;
                actionButton.appendChild(span);
                td.appendChild(actionButton);
            } else if (fieldName === 'interfaces') {
                const proxyInterfaceUrl = DeviceTracker.createUrl(this.params, device.udid).toString();
                const proxyInterfaceName = 'proxy';
                const localStorageKey = DeviceTracker.getLocalStorageKey(fullName);
                const lastSelected = localStorage && localStorage.getItem(localStorageKey);
                const selectElement = document.createElement('select');
                selectElement.setAttribute(Attribute.UDID, device.udid);
                selectElement.setAttribute(Attribute.FULL_NAME, fullName);
                selectElement.setAttribute(
                    'name',
                    encodeURIComponent(`${DeviceTracker.AttributePrefixInterfaceSelectFor}${fullName}`),
                );
                /// #if SCRCPY_LISTENS_ON_ALL_INTERFACES
                device.interfaces.forEach((value) => {
                    const params = {
                        ...this.params,
                        secure: false,
                        hostname: value.ipv4,
                        port: SERVER_PORT,
                    };
                    const url = DeviceTracker.createUrl(params).toString();
                    const optionElement = DeviceTracker.createInterfaceOption(value.name, url);
                    optionElement.innerText = `${value.name}: ${value.ipv4}`;
                    selectElement.appendChild(optionElement);
                    if (lastSelected) {
                        if (lastSelected === value.name || !selectedInterfaceName) {
                            optionElement.selected = true;
                            selectedInterfaceUrl = url;
                            selectedInterfaceName = value.name;
                        }
                    } else if (device['wifi.interface'] === value.name) {
                        optionElement.selected = true;
                    }
                });
                /// #else
                selectedInterfaceUrl = proxyInterfaceUrl;
                selectedInterfaceName = proxyInterfaceName;
                td.classList.add('hidden');
                /// #endif
                if (isActive) {
                    const adbProxyOption = DeviceTracker.createInterfaceOption(proxyInterfaceName, proxyInterfaceUrl);
                    if (lastSelected === proxyInterfaceName || !selectedInterfaceName) {
                        adbProxyOption.selected = true;
                        selectedInterfaceUrl = proxyInterfaceUrl;
                        selectedInterfaceName = proxyInterfaceName;
                    }
                    selectElement.appendChild(adbProxyOption);
                    const actionButton = document.createElement('button');
                    actionButton.className = 'action-button update-interfaces-button active';
                    actionButton.title = `Update information`;
                    actionButton.appendChild(SvgImage.create(SvgImage.Icon.REFRESH));
                    actionButton.setAttribute(Attribute.UDID, device.udid);
                    actionButton.setAttribute(Attribute.COMMAND, ControlCenterCommand.UPDATE_INTERFACES);
                    actionButton.onclick = this.onActionButtonClick;
                    td.appendChild(actionButton);
                }
                selectElement.onchange = this.onInterfaceSelected;
                td.appendChild(selectElement);
            } else {
                td.innerText = value;
            }
        });

        if (DeviceTracker.CREATE_DIRECT_LINKS && playersContainer) {
            const name = `${DeviceTracker.AttributePrefixPlayerFor}${fullName}`;
            StreamClientScrcpy.getPlayers().forEach((playerClass) => {
                const { playerCodeName, playerFullName } = playerClass;
                const playerTd = document.createElement('div');
                playerTd.classList.add(blockClass, 'player-chip');
                playerTd.setAttribute('name', encodeURIComponent(name));
                playerTd.setAttribute(DeviceTracker.AttributePlayerFullName, encodeURIComponent(playerFullName));
                playerTd.setAttribute(DeviceTracker.AttributePlayerCodeName, encodeURIComponent(playerCodeName));
                playersContainer.appendChild(playerTd);
            });
        }

        if (quickConnectBtn && isActive) {
            quickConnectBtn.onclick = (event: MouseEvent) => {
                if (!hasPid) {
                    event.preventDefault();
                    const targetWindow = window.open('about:blank', '_blank');
                    if (targetWindow) {
                        try {
                            targetWindow.document.write(`
                                <!DOCTYPE html>
                                <html lang="vi">
                                <head>
                                    <title>Miroo - Đang khởi động...</title>
                                    <meta charset="utf-8">
                                    <meta name="viewport" content="width=device-width, initial-scale=1.0">
                                    <style>
                                        body {
                                            margin: 0;
                                            height: 100vh;
                                            display: flex;
                                            flex-direction: column;
                                            align-items: center;
                                            justify-content: center;
                                            background: #0b0f19;
                                            color: #f1f5f9;
                                            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
                                            text-align: center;
                                            padding: 20px;
                                            box-sizing: border-box;
                                        }
                                        .spinner {
                                            width: 44px;
                                            height: 44px;
                                            border: 3.5px solid rgba(59, 130, 246, 0.2);
                                            border-top-color: #3b82f6;
                                            border-radius: 50%;
                                            animation: spin 0.8s linear infinite;
                                            margin-bottom: 22px;
                                        }
                                        @keyframes spin { to { transform: rotate(360deg); } }
                                        h2 { font-size: 19px; margin: 0 0 10px; font-weight: 600; }
                                        p { font-size: 13.5px; color: #94a3b8; margin: 0; max-width: 420px; line-height: 1.5; }
                                    </style>
                                </head>
                                <body>
                                    <div class="spinner"></div>
                                    <h2>Đang kết nối tới ${displayName}...</h2>
                                    <p>Đang tự động khởi chạy scrcpy-server trên thiết bị. Cửa sổ điều khiển sẽ mở trong giây lát.</p>
                                </body>
                                </html>
                            `);
                        } catch (e) {
                            // cross-origin ignore
                        }
                    }

                    this.sendStartServer(device.udid);
                    const qcText = quickConnectBtn.querySelector('.qc-btn-text');
                    if (qcText) {
                        qcText.textContent = 'Đang khởi động server...';
                    }

                    const checkInterval = setInterval(() => {
                        const current = this.getDescriptorByUdid(device.udid);
                        if (current && current.pid && current.pid !== -1) {
                            clearInterval(checkInterval);
                            clearTimeout(timeoutTimer);
                            if (targetWindow && !targetWindow.closed) {
                                const btn = document.getElementById(quickConnectId) as HTMLAnchorElement | null;
                                if (btn && btn.href && btn.href !== 'javascript:void(0)' && !btn.href.endsWith('#')) {
                                    targetWindow.location.href = btn.href;
                                }
                            }
                        }
                    }, 250);

                    const timeoutTimer = setTimeout(() => {
                        clearInterval(checkInterval);
                        if (qcText) {
                            qcText.textContent = 'Bắt đầu điều khiển';
                        }
                        if (targetWindow && !targetWindow.closed) {
                            targetWindow.document.body.innerHTML = `
                                <div style="text-align:center; padding: 40px; font-family: sans-serif; color: #f87171;">
                                    <h3>Không thể khởi động scrcpy server</h3>
                                    <p style="color:#94a3b8; font-size: 14px;">Vui lòng kiểm tra quyền gỡ lỗi USB trên điện thoại hoặc bấm "Quét lại thiết bị".</p>
                                </div>
                            `;
                        }
                    }, 12000);
                }
            };
        }

        tbody.appendChild(row);
        if (DeviceTracker.CREATE_DIRECT_LINKS && selectedInterfaceUrl) {
            this.updateLink({
                url: selectedInterfaceUrl,
                name: selectedInterfaceName,
                fullName,
                udid: device.udid,
                store: false,
            });
        }
    }

    protected getChannelCode(): string {
        return ChannelCode.GTRC;
    }

    public destroy(): void {
        super.destroy();
        DeviceTracker.instancesByUrl.delete(this.url.toString());
        if (!DeviceTracker.instancesByUrl.size) {
            const holder = document.getElementById(BaseDeviceTracker.HOLDER_ELEMENT_ID);
            if (holder && holder.parentElement) {
                holder.parentElement.removeChild(holder);
            }
        }
    }
}
