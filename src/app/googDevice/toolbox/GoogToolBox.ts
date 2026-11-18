import { ToolBox } from '../../toolbox/ToolBox';
import KeyEvent from '../android/KeyEvent';
import SvgImage from '../../ui/SvgImage';
import { KeyCodeControlMessage } from '../../controlMessage/KeyCodeControlMessage';
import { ToolBoxButton } from '../../toolbox/ToolBoxButton';
import { ToolBoxElement } from '../../toolbox/ToolBoxElement';
import { ToolBoxCheckbox } from '../../toolbox/ToolBoxCheckbox';
import { StreamClientScrcpy } from '../client/StreamClientScrcpy';
import { BasePlayer } from '../../player/BasePlayer';

const BUTTONS = [
    {
        title: 'Power',
        code: KeyEvent.KEYCODE_POWER,
        icon: SvgImage.Icon.POWER,
    },
    {
        title: 'Volume up',
        code: KeyEvent.KEYCODE_VOLUME_UP,
        icon: SvgImage.Icon.VOLUME_UP,
    },
    {
        title: 'Volume down',
        code: KeyEvent.KEYCODE_VOLUME_DOWN,
        icon: SvgImage.Icon.VOLUME_DOWN,
    },
    {
        title: 'Back',
        code: KeyEvent.KEYCODE_BACK,
        icon: SvgImage.Icon.BACK,
    },
    {
        title: 'Home',
        code: KeyEvent.KEYCODE_HOME,
        icon: SvgImage.Icon.HOME,
    },
    {
        title: 'Overview',
        code: KeyEvent.KEYCODE_APP_SWITCH,
        icon: SvgImage.Icon.OVERVIEW,
    },
];

export interface GoogToolBoxOptions {
    // Start with keyboard capture enabled instead of requiring the user to tick
    // the "Capture keyboard" checkbox first.
    captureKeyboard?: boolean;
}

export class GoogToolBox extends ToolBox {
    protected constructor(list: ToolBoxElement<any>[]) {
        super(list);
    }

    public static createToolBox(
        udid: string,
        player: BasePlayer,
        client: StreamClientScrcpy,
        moreBox?: HTMLElement,
        options: GoogToolBoxOptions = {},
    ): GoogToolBox {
        const playerName = player.getName();
        const list = BUTTONS.slice();
        const handler = <K extends keyof HTMLElementEventMap, T extends HTMLElement>(
            type: K,
            element: ToolBoxElement<T>,
        ) => {
            if (!element.optional?.code) {
                return;
            }
            const { code } = element.optional;
            const action = type === 'mousedown' ? KeyEvent.ACTION_DOWN : KeyEvent.ACTION_UP;
            const event = new KeyCodeControlMessage(action, code, 0, 0);
            client.sendMessage(event);
        };
        const elements: ToolBoxElement<any>[] = list.map((item) => {
            const button = new ToolBoxButton(item.title, item.icon, {
                code: item.code,
            });
            button.addEventListener('mousedown', handler);
            button.addEventListener('mouseup', handler);
            return button;
        });
        if (player.supportsScreenshot) {
            const screenshot = new ToolBoxButton('Take screenshot', SvgImage.Icon.CAMERA);
            screenshot.addEventListener('click', () => {
                player.createScreenshot(client.getDeviceName());
            });
            elements.push(screenshot);
        }

        const fullscreen = new ToolBoxButton('Phóng to toàn màn hình (F)', SvgImage.Icon.FULL_SCREEN);
        fullscreen.addEventListener('click', () => {
            if (!document.fullscreenElement) {
                const target = document.documentElement || player.getParent();
                target?.requestFullscreen().catch(() => {
                    player.getParent()?.requestFullscreen();
                });
            } else {
                document.exitFullscreen().catch(() => void 0);
            }
        });
        elements.push(fullscreen);

        let toastTimer: ReturnType<typeof setTimeout> | null = null;
        const showLiveToast = (msg: string) => {
            let toast = document.querySelector('.livestream-toast') as HTMLElement;
            if (!toast) {
                toast = document.createElement('div');
                toast.className = 'livestream-toast';
                document.body.appendChild(toast);
            }
            toast.innerHTML = `<span class="live-dot"></span><span>${msg}</span>`;
            toast.classList.add('show');
            if (toastTimer) {
                clearTimeout(toastTimer);
            }
            toastTimer = setTimeout(() => {
                toast.classList.remove('show');
            }, 3500);
        };

        let idleCursorTimer: ReturnType<typeof setTimeout> | null = null;
        const resetIdleCursor = () => {
            if (!document.body.classList.contains('livestream-mode')) {
                document.body.classList.remove('hide-cursor');
                return;
            }
            document.body.classList.remove('hide-cursor');
            if (idleCursorTimer) {
                clearTimeout(idleCursorTimer);
            }
            idleCursorTimer = setTimeout(() => {
                if (document.body.classList.contains('livestream-mode')) {
                    document.body.classList.add('hide-cursor');
                }
            }, 2500);
        };
        window.addEventListener('mousemove', resetIdleCursor);

        const toggleLiveStreamMode = () => {
            const isLive = document.body.classList.toggle('livestream-mode');
            if (isLive) {
                showLiveToast('🔴 Chế độ Live Stream đã bật (Nhấn phím "L" hoặc Esc để thoát)');
                resetIdleCursor();
            } else {
                document.body.classList.remove('hide-cursor');
                showLiveToast('Đã thoát chế độ Live Stream');
            }
        };

        window.addEventListener('keydown', (e: KeyboardEvent) => {
            if (['INPUT', 'TEXTAREA'].includes((e.target as HTMLElement)?.tagName)) {
                return;
            }
            if (e.key === 'l' || e.key === 'L') {
                toggleLiveStreamMode();
            } else if (e.key === 'f' || e.key === 'F') {
                if (!document.fullscreenElement) {
                    document.documentElement.requestFullscreen().catch(() => void 0);
                } else {
                    document.exitFullscreen().catch(() => void 0);
                }
            } else if (e.key === 'Escape' && document.body.classList.contains('livestream-mode')) {
                toggleLiveStreamMode();
            }
        });

        const liveStreamBtn = new ToolBoxButton('Live Stream / OBS Mode (L)', SvgImage.Icon.LIVESTREAM);
        liveStreamBtn.addEventListener('click', () => {
            toggleLiveStreamMode();
        });
        elements.push(liveStreamBtn);

        const audioPlayer = client.getAudioPlayer();
        if (audioPlayer) {
            const isInitiallyMuted = audioPlayer.isMuted();
            const audioBtn = new ToolBoxButton(
                isInitiallyMuted ? 'Unmute Audio' : 'Mute Audio',
                isInitiallyMuted ? SvgImage.Icon.VOLUME_OFF : SvgImage.Icon.VOLUME_UP,
            );
            const updateAudioIcon = (isMuted: boolean) => {
                const btnElement = audioBtn.getElement();
                const label = isMuted ? 'Unmute Audio' : 'Mute Audio';
                btnElement.setAttribute('aria-label', label);
                btnElement.setAttribute('data-title', label);
                const newSvg = SvgImage.create(isMuted ? SvgImage.Icon.VOLUME_OFF : SvgImage.Icon.VOLUME_UP);
                const oldSvg = btnElement.querySelector('svg');
                if (oldSvg) {
                    btnElement.replaceChild(newSvg, oldSvg);
                }
            };
            audioBtn.addEventListener('click', () => {
                audioPlayer.resume().catch(() => void 0);
                const isMuted = audioPlayer.toggleMute();
                updateAudioIcon(isMuted);
            });
            audioPlayer.on('mute-change', (isMuted: boolean) => {
                updateAudioIcon(isMuted);
            });
            elements.push(audioBtn);
        }

        const keyboard = new ToolBoxCheckbox(
            'Capture keyboard',
            SvgImage.Icon.KEYBOARD,
            `capture_keyboard_${udid}_${playerName}`,
        );
        keyboard.addEventListener('click', (_, el) => {
            const element = el.getElement();
            client.setHandleKeyboardEvents(element.checked);
        });
        if (options.captureKeyboard) {
            keyboard.getElement().checked = true;
            client.setHandleKeyboardEvents(true);
        }
        elements.push(keyboard);

        if (moreBox) {
            const displayId = player.getVideoSettings().displayId;
            const id = `show_more_${udid}_${playerName}_${displayId}`;
            const more = new ToolBoxCheckbox('More', SvgImage.Icon.MORE, id);
            more.addEventListener('click', (_, el) => {
                const element = el.getElement();
                moreBox.style.display = element.checked ? 'block' : 'none';
            });
            elements.unshift(more);
        }
        return new GoogToolBox(elements);
    }
}
