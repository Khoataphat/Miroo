import { BaseDeviceTracker } from '../../client/BaseDeviceTracker';
import { ACTION } from '../../../common/Action';
import ApplDeviceDescriptor from '../../../types/ApplDeviceDescriptor';
import Util from '../../Util';
import { html } from '../../ui/HtmlTag';
import { DeviceState } from '../../../common/DeviceState';
import { HostItem } from '../../../types/Configuration';
import { ChannelCode } from '../../../common/ChannelCode';
import { Tool } from '../../client/Tool';

export class DeviceTracker extends BaseDeviceTracker<ApplDeviceDescriptor, never> {
    public static ACTION = ACTION.APPL_DEVICE_LIST;
    protected static tools: Set<Tool> = new Set();
    private static instancesByUrl: Map<string, DeviceTracker> = new Map();

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
    protected tableId = 'appl_devices_list';
    constructor(params: HostItem, directUrl: string) {
        super({ ...params, action: DeviceTracker.ACTION }, directUrl);
        DeviceTracker.instancesByUrl.set(directUrl, this);
        this.buildDeviceTable();
        this.openNewConnection();
    }

    protected onSocketOpen(): void {
        // do nothing;
    }

    protected buildDeviceRow(tbody: Element, device: ApplDeviceDescriptor): void {
        const blockClass = 'desc-block';
        const fullName = `${this.id}_${Util.escapeUdid(device.udid)}`;
        const isActive = device.state === DeviceState.CONNECTED;
        const servicesId = `device_services_${fullName}`;
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
                            <span class="device-name">${device.name}</span>
                        </div>
                        <div class="device-serial-row">
                            <span class="device-model">${device.model}</span>
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
                        <span class="spec-label">iOS</span>
                        <span class="release-version spec-value">${device.version}</span>
                    </div>
                </div>
                <div id="${servicesId}" class="services"></div>
            </div>
        </div>`.content;
        const services = row.getElementById(servicesId);
        if (!services) {
            return;
        }

        DeviceTracker.tools.forEach((tool) => {
            const entry = tool.createEntryForDeviceList(device, blockClass, this.params);
            if (entry) {
                if (Array.isArray(entry)) {
                    entry.forEach((item) => {
                        item && services.appendChild(item);
                    });
                } else {
                    services.appendChild(entry);
                }
            }
        });
        tbody.appendChild(row);
    }

    protected getChannelCode(): string {
        return ChannelCode.ATRC;
    }
}
