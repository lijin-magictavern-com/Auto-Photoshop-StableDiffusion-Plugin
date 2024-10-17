import React from 'react'
import ReactDOM from 'react-dom/client'
import { observer } from 'mobx-react'
import { AStore } from '../main/astore'

import { SpCheckBox, SpMenu, SpSlider, SpTextfield } from '../util/elements'
import Locale from '../locale/locale'
import globalStore from '../globalstore'
import { io } from '../util/oldSystem'
import { reaction } from 'mobx'
//@ts-ignore
import { storage } from 'uxp'
import md5 from 'md5';
import { ErrorBoundary } from '../util/errorBoundary'
import { MaskModeEnum, ScriptMode } from '../util/ts/enum'
import { store as progress_store } from '../session/progress'
import { requestPost } from '../util/ts/api'
import { comfyapi } from '../entry'

// import { Jimp } from '../util/oldSystem'
declare const Jimp: any // make sure you import jimp before importing settings.tsx
declare let g_sd_url: string
type InterpolationMethod = {
    [key: string]: {
        photoshop: string
        jimp: string
    }
}

const interpolationMethods: InterpolationMethod = {
    nearestNeighbor: {
        photoshop: 'nearestNeighbor',
        jimp: Jimp.RESIZE_NEAREST_NEIGHBOR,
    },
    bicubic: {
        photoshop: 'bicubicAutomatic',
        jimp: Jimp.RESIZE_BICUBIC,
    },
    bilinear: {
        photoshop: 'bilinear',
        jimp: Jimp.RESIZE_BILINEAR,
    },
}

enum ExtensionTypeEnum {
    ProxyServer = 'proxy_server',
    Auto1111Extension = 'auto1111_extension',
    None = 'none',
}
const config = {
    [ExtensionTypeEnum.ProxyServer]: {
        title: "use the proxy server, need to run 'start_server.bat' ",
        value: ExtensionTypeEnum.ProxyServer,
        label: 'Proxy Server',
    },
    [ExtensionTypeEnum.Auto1111Extension]: {
        title: 'use Automatic1111 Photoshop SD Extension, need to install the extension in Auto1111',
        value: ExtensionTypeEnum.Auto1111Extension,
        label: 'Auto1111 Extension',
    },
    [ExtensionTypeEnum.None]: {
        title: 'Use the Plugin Only No Additional Component',
        value: ExtensionTypeEnum.None,
        label: 'None',
    },
}

function extensionTypeName(extension_type: ExtensionTypeEnum) {
    return extension_type
        .split('_')
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ')
}
interface AStoreData {
    scale_interpolation_method: typeof interpolationMethods.bilinear
    should_log_to_file: boolean
    delete_log_file_timer_id: ReturnType<typeof setInterval> | undefined
    b_borders_or_corners: MaskModeEnum
    use_image_cfg_scale_slider: boolean
    extension_type: ExtensionTypeEnum
    use_sharp_mask: boolean
    use_prompt_shortcut: boolean
    bTurnOffServerStatusAlert: boolean
    CLIP_stop_at_last_layers: number
    use_smart_object: boolean
    selected_backend: 'Automatic1111' | 'ComfyUI'
    comfy_url: string
    username: string
    password: string
    muses_token: string
}
export const store = new AStore<AStoreData>({
    scale_interpolation_method: interpolationMethods.bilinear,
    should_log_to_file:
        JSON.parse(storage.localStorage.getItem('should_log_to_file')) || false,
    delete_log_file_timer_id: undefined,
    b_borders_or_corners: MaskModeEnum.Transparent,
    use_image_cfg_scale_slider: false,
    extension_type: ExtensionTypeEnum.Auto1111Extension,
    use_sharp_mask: false,
    use_prompt_shortcut: false,
    bTurnOffServerStatusAlert:
        JSON.parse(storage.localStorage.getItem('bTurnOffServerStatusAlert')) ||
        false,
    CLIP_stop_at_last_layers: 1,
    use_smart_object: true, // true to keep layer as smart objects, false to rasterize them
    // selected_backend: 'Automatic1111' as 'Automatic1111' | 'ComfyUI',
    selected_backend: (storage.localStorage.getItem('selected_backend') ||
        'ComfyUI') as 'Automatic1111' | 'ComfyUI',
    comfy_url:
        storage.localStorage.getItem('comfy_url') || 'https://muses-test.magictavern.com/api/v1/comfy',
    username: storage.localStorage.getItem('username') || '',
    password: storage.localStorage.getItem('password') || '',
    muses_token: storage.localStorage.getItem('muses_token')
})

function onShouldLogToFileChange(event: any) {
    try {
        const should_log_to_file: boolean = event.target.checked
        store.data.should_log_to_file = should_log_to_file
        storage.localStorage.setItem('should_log_to_file', should_log_to_file)
        if (should_log_to_file && !store.data.delete_log_file_timer_id) {
            store.data.delete_log_file_timer_id = setDeleteLogTimer()
        } else {
            //don't log and clear delete file timer
            try {
                clearInterval(
                    store.data.delete_log_file_timer_id as ReturnType<
                        typeof setInterval
                    >
                )
                store.data.delete_log_file_timer_id = undefined
            } catch (e) {
                console.warn(e)
            }
        }

        //@ts-ignore
        setLogMethod(should_log_to_file)
    } catch (e) {
        console.warn(e)
    }
}

function setDeleteLogTimer() {
    const timer_id = setInterval(async () => {
        await io.deleteFileIfLargerThan('log.txt', 200)
    }, 2 * 60 * 1000)
    console.log('setDeleteLogTimer() timer_id :', timer_id)
    return timer_id
}
async function postOptions(options: Object) {
    try {
        const full_url = `${g_sd_url}/sdapi/v1/options`
        await requestPost(full_url, options)
    } catch (e) {
        console.warn('failed postOptions at : ', g_sd_url, options, e)
    }
}

interface Options {
    [key: string]: number
    CLIP_stop_at_last_layers: number
}

interface SettingsState {
    authStatus: 'success' | 'fail' | 'pending' | null;
  }

async function getOptions(): Promise<Options | null> {
    const full_url = `${g_sd_url}/sdapi/v1/options`
    try {
        const response = await fetch(full_url)
        if (response.status === 404) return null
        return await response.json()
    } catch (error) {
        console.error(`Error fetching from ${full_url}:`, error)
        return null
    }
}

@observer
export class Settings extends React.Component<{}> {
    state: SettingsState = {
        authStatus: null,
      };

    async componentDidMount(): Promise<void> {
        if (store.data.selected_backend === 'Automatic1111') {
            const options = await getOptions()

            store.data.CLIP_stop_at_last_layers =
                options?.CLIP_stop_at_last_layers ??
                store.data.CLIP_stop_at_last_layers
        }
    }

    render() {
        return (
            <div style={{ width: '100%' }}>
                <sp-label>ComfyUI Url:</sp-label>
                <SpTextfield
                    type="text"
                    placeholder="https://muses-test.magictavern.com/api/v1/comfy"
                    // value={config.default}
                    value={store.data.comfy_url}
                    onChange={(event: any) => {
                        // store.data.search_query = event.target.value

                        let url = event.target.value.trim() // remove leading and trailing white spaces
                        url = url.replace(/[/\\]$/, '')
                        store.data.comfy_url = url || "https://muses-test.magictavern.com/api/v1/comfy"
                        comfyapi.comfy_api.setUrl(store.data.comfy_url)
                        storage.localStorage.setItem(
                            'comfy_url',
                            store.data.comfy_url
                        )
                    }}
                ></SpTextfield>
                <div>
                    <sp-label>外部认证:</sp-label>
                    <br />
                    <sp-label>用户名:</sp-label>
                    <SpTextfield
                        type="text"
                        placeholder="请输入用户名"
                        value={store.data.username}
                        onChange={(event: any) => {
                            store.data.username = event.target.value.trim();
                        }}
                    ></SpTextfield>
                    <br />
                    <sp-label>密码:</sp-label>
                    <SpTextfield
                        type="password"
                        placeholder="请输入密码"
                        value={store.data.password}
                        onChange={(event: any) => {
                            const hashedPassword = md5(event.target.value);
                            store.data.password = hashedPassword;

                        }}
                    ></SpTextfield>

                    <button
                        className="btnSquare"
                        onClick={async () => {
                            try {
                                storage.localStorage.setItem('username', store.data.username);
                                storage.localStorage.setItem('password', store.data.password);
                                const response = await fetch(`https://muses-test.magictavern.com/api/auth/user`, {
                                    method: 'POST',
                                    headers: {
                                        'Content-Type': 'application/json',
                                    },
                                    body: JSON.stringify({
                                        name: store.data.username,
                                        pwd: store.data.password,
                                    }),
                                });
                                if (response.status === 200 || response.status === 201) {
                                    const result = await response.json();
                                    console.log(result)
                                    if (result.token) {
                                        this.setState({ authStatus: 'success' });
                                        store.data.muses_token = result.token; // 将返回的token存储到store中
                                        storage.localStorage.setItem('muses_token', result.token);
                                        // await util.fetchData()
                                    } else {
                                        this.setState({ authStatus: 'fail' });
                                    }
                                } else {
                                    this.setState({ authStatus: 'fail' });
                                }
                            } catch (error) {
                                console.error('认证过程出错:', error);
                                this.setState({ authStatus: 'fail' });
                            }
                        }}
                    >
                        认证
                    </button>
                    {this.state.authStatus === 'success' && (
                        <div style={{ color: 'green', marginTop: '5px' }}>认证成功</div>
                    )}
                    {this.state.authStatus === 'fail' && (
                        <div style={{ color: 'red', marginTop: '5px' }}>认证失败</div>
                    )}
                </div>
            </div>
        )
    }
}
const containerNode = document.getElementById('reactSettingsContainer')!
const root = ReactDOM.createRoot(containerNode)

root.render(
    //<React.StrictMode>
    <ErrorBoundary>
        <Settings></Settings>
    </ErrorBoundary>
    //</React.StrictMode>
)

progress_store.data.live_progress_image

export default {
    store: store,
}
