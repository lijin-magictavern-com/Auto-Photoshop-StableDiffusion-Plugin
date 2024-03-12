import React from 'react'
import ReactDOM from 'react-dom/client'
import { requestGet, requestPost } from '../util/ts/api'
import { observer } from 'mobx-react'
import { runInAction } from 'mobx'
import {
    MoveToCanvasSvg,
    SliderType,
    SpMenu,
    SpSlider,
    SpSliderWithLabel,
    SpTextfield,
} from '../util/elements'
import { ErrorBoundary } from '../util/errorBoundary'
import { Collapsible } from '../util/collapsible'
import Locale from '../locale/locale'

import { Grid } from '../util/grid'
import { io } from '../util/oldSystem'
import { app, core } from 'photoshop'
import { reaction, toJS } from 'mobx'
import { host, storage } from 'uxp'

import util, {
    ComfyInputType,
    ComfyUINode,
    InputTypeEnum,
    ValidInput,
    store,
} from './util'

import {
    base64UrlToBase64,
    copyJson,
    deleteKeys,
    getImageFromCanvas_new,
    isValidVersion,
    urlToCanvas,
} from '../util/ts/general'
import comfyapi from './comfyapi'
import { getSelectionInfoExe } from '../../psapi'
import { moveImageToLayer } from '../util/ts/io'
import { reuseOrUploadComfyImage } from './main_ui'
import { SetLayerColor } from '../util/ts/layer'

interface Error {
    type: string
    message: string
    details: string
    extra_info: any
}

interface NodeError {
    errors: Error[]
    dependent_outputs: string[]
    class_type: string
}

interface Result {
    error?: Error
    node_errors?: { [key: string]: NodeError }
}

function logError(result: Result) {
    // Top-level error
    let has_error = false
    let errorMessage = ''

    // Top-level error
    if (result.error) {
        errorMessage += `Error: ${result.error.message}\n`
        has_error = true
        if (result.error.details) {
            errorMessage += `Details: ${result.error.details}\n`
        }
    }

    // Node errors
    if (result.node_errors) {
        for (const [node_id, node_error] of Object.entries(
            result.node_errors
        )) {
            errorMessage += `Node ${node_id}:\n`
            has_error = true
            for (const error of node_error.errors) {
                errorMessage += `- Error: ${error.message}\n`
                if (error.details) {
                    errorMessage += `  Details: ${error.details}\n`
                }
            }
        }
    }

    if (errorMessage) {
        app.showAlert(errorMessage)
    }
    return has_error
}

export async function workflowEntries() {
    try {
        const workflow_folder = await storage.localFileSystem.getFolder()

        let entries = await workflow_folder.getEntries()
        const workflow_entries = entries.filter(
            // (e: any) => e.isFile && e.name.toLowerCase().includes('.png') // must be a file and has the of the type .png
            (e: any) => e.isFile && e.name.toLowerCase().includes('.json') // must be a file and has the of the type .json
        )

        console.log('workflow_entries: ', workflow_entries)

        return workflow_entries
    } catch (e) {
        console.error(e)
        // throw e
        return []
    }
}
export async function postPrompt(prompt: any) {
    try {
        const url = `${comfyapi.comfy_api.comfy_url}/prompt`
        const payload = {
            prompt: prompt,
        }
        const result = await requestPost(url, payload)

        return result
    } catch (e) {
        console.error(e)
    }
}

const timer = (ms: any) => new Promise((res) => setTimeout(res, ms))

export async function generateRequest(prompt: any) {
    try {
        const prompt_result = await postPrompt(prompt)
        const prompt_id = prompt_result.prompt_id
        let history_result: any
        let numberOfAttempts = 0
        let has_error = logError(prompt_result)
        while (true && !has_error) {
            try {
                console.log('get history attempt: ', numberOfAttempts)
                history_result = await util.getHistory(prompt_id)
                console.log('history_result:', history_result)
                if (history_result?.[prompt_id]) break

                numberOfAttempts += 1
                await timer(5000)
            } catch (e) {
                console.log('getHistory failed, retrying...')
            }
        }
        return { history_result: history_result, prompt_id: prompt_id }
    } catch (e) {
        console.error(e)
    }
}
export async function generateImage(prompt: any) {
    try {
        let { history_result, prompt_id }: any = await generateRequest(prompt)

        const outputs: any[] = Object.values(history_result[prompt_id].outputs)
        const images: any[] = []
        for (const output of outputs) {
            if (Array.isArray(output.images)) {
                images.push(...output.images)
            }
        }

        const base64_imgs = []
        const formats: string[] = []

        for (const image of images) {
            const img = await comfyapi.comfy_api.view(
                image.filename,
                image.type,
                image.subfolder
            )
            base64_imgs.push(img)
            formats.push(util.getFileFormat(image.filename))
        }

        store.data.comfyui_output_images = base64_imgs

        const thumbnails = []
        for (let i = 0; i < base64_imgs.length; ++i) {
            if (['png', 'webp', 'jpg'].includes(formats[i])) {
                thumbnails.push(await io.createThumbnail(base64_imgs[i], 300))
            } else if (['gif'].includes(formats[i])) {
                thumbnails.push('data:image/gif;base64,' + base64_imgs[i])
            }
        }

        store.data.comfyui_output_thumbnail_images = thumbnails

        return base64_imgs
    } catch (e) {
        console.error(e)
    }
}

export async function getConfig() {
    //TODO: replace this method with get_object_info from comfyapi
    try {
        const prompt = {
            '1': {
                inputs: {},
                class_type: 'GetConfig',
            },
        }

        let { history_result, prompt_id }: any = await generateRequest(prompt)
        //@ts-ignore
        const config: ComfyUIConfig = Object.values(
            history_result?.[prompt_id].outputs
        )[0]
        store.data.comfyui_config = { ...config }
        store.data.comfyui_config.valid_nodes = JSON.parse(
            config.valid_nodes.join('')
        )

        return config
    } catch (e) {
        console.error(e)
    }
}
export async function getWorkflowApi(image_path: string) {
    try {
        const prompt = {
            '1': {
                inputs: {
                    // image: 'C:/Users/abdul/Downloads/img2img_workflow.png',
                    image_path: image_path,
                },
                class_type: 'LoadImageWithMetaData',
            },
        }
        let { history_result, prompt_id }: any = await generateRequest(prompt)
        //@ts-ignore
        let { prompt: result_prompt, workflow } = Object.values(
            history_result?.[prompt_id].outputs
        )[0]
        result_prompt = JSON.parse(result_prompt.join(''))
        workflow = JSON.parse(workflow.join(''))

        return { prompt: result_prompt, workflow }
    } catch (e) {
        console.error(e)
    }
}
function filterObjectProperties(node_inputs: any, valid_keys: string[]) {
    return Object.fromEntries(
        valid_keys.map((key: string) => [key, node_inputs[key]])
    )
}
export function parseUIFromNode(node: ComfyUINode, node_id: string) {
    //convert node to array of ui element definition
    try {
        const ValidNodes = store.data.comfyui_config?.valid_nodes
        const valid_ui = ValidNodes[node.class_type]?.inputs // all the valid inputs of a node
        const list_ids = ValidNodes[node.class_type]?.list_id
        if (valid_ui) {
            const keys = Object.keys(valid_ui)
            const filtered_values = filterObjectProperties(node.inputs, keys)
            const entires = keys.map((key) => {
                //example values:
                // "sampler_name": {
                // "label": "sampler_name",
                // "value": "dpmpp_2m",
                // "type": "Menu",
                // "list_id": "samplers"
                // },

                return [
                    key,
                    {
                        label: key,
                        value: filtered_values[key],
                        type: valid_ui[key],
                        list_id: list_ids?.[key],
                        node_id: node_id,
                    },
                ]
            })

            const valid_node_input = Object.fromEntries(entires)
            store.data.comfyui_valid_nodes[node_id] = valid_node_input
            store.data.uuids[node_id] = window.crypto.randomUUID()
            return valid_node_input
        }
    } catch (e) {
        console.error(e)
    }
}

export function storeToPrompt(store: any, basePrompt: any) {
    //TODO change .map to .forEach
    let modified_prompt = { ...basePrompt } // the original prompt but with the value of the ui
    Object.entries(store.data.comfyui_valid_nodes).forEach(
        ([node_id, node_inputs]: [string, any]) => {
            Object.entries(node_inputs).forEach(
                ([input_id, node_input]: [string, any]) => {
                    return (modified_prompt[node_id]['inputs'][input_id] =
                        node_input.value)
                }
            )
        }
    )
    // store.data.
    // modified_propmt[load_image_node_id]
    // prompt = { ...store.data.comfyui_valid_nodes }

    return modified_prompt
}
function createMenu(input: ValidInput) {
    console.log('input: ', toJS(input))
    return (
        <>
            <sp-label
                class="title"
                style={{ width: '60px', display: 'inline-block' }}
            >
                {input.label}
            </sp-label>
            <SpMenu
                size="m"
                title="input.label"
                items={store.data.comfyui_config[input.list_id]}
                label_item={`Select ${input.label}`}
                selected_index={store.data.comfyui_config[
                    input.list_id
                ]!.indexOf(input.value)}
                onChange={(id: any, value: any) => {
                    input.value = value.item
                }}
            ></SpMenu>
        </>
    )
}

function createTextField(input: ValidInput) {
    let element = (
        <>
            <sp-label>{input.label}</sp-label>
            <SpTextfield
                style={{ width: '100%' }}
                title=""
                type={input.type.includes('number') ? 'number' : 'text'}
                placeholder=""
                value={input.value}
                onChange={(evt: any) => {
                    input.value = evt.target.value
                }}
            ></SpTextfield>
        </>
    )
    return element
}
function createTextArea(input: ValidInput) {
    let element = (
        <>
            <sp-label>{input.label}</sp-label>
            <sp-textarea
                onInput={(event: any) => {
                    input.value = event.target.value
                }}
                placeholder={`${input.label}`}
                value={input.value}
            ></sp-textarea>
        </>
    )
    return element
}
function createImageBase64(input: ValidInput) {
    let element = (
        <>
            <div>
                <img
                    className="column-item-image"
                    src={
                        // store.data.load_image_base64_strings?.[input.node_id]
                        input.value
                            ? 'data:image/png;base64,' +
                              //   store.data.load_image_base64_strings?.[
                              //       input.node_id
                              //   ]
                              input.value
                            : 'https://source.unsplash.com/random'
                    }
                    width="300px"
                    height="100px"
                />
            </div>
            <div className="imgButton">
                <button
                    className="column-item button-style btnSquare"
                    onClick={async () => {
                        input.value = await io.getImg2ImgInitImage()
                    }}
                    title=""
                >
                    {Locale('Set Image')}
                </button>
            </div>
        </>
    )
    return element
}
function nodeInputToHtmlElement(input: ValidInput) {
    let element
    if (
        [InputTypeEnum.NumberField, InputTypeEnum.TextField].includes(
            input.type
        )
    ) {
        element = createTextField(input)
    } else if ([InputTypeEnum.Menu].includes(input.type)) {
        element = createMenu(input)
    } else if ([InputTypeEnum.TextArea].includes(input.type)) {
        element = createTextArea(input)
    } else if ([InputTypeEnum.ImageBase64].includes(input.type)) {
        element = createImageBase64(input)
    }
    return element
}

export async function loadWorkflow(workflow_path: string) {
    try {
        store.data.current_prompt = (
            await getWorkflowApi(workflow_path)
        )?.prompt

        store.data.is_random_seed = Object.fromEntries(
            Object.keys(toJS(store.data.current_prompt)).map(
                (node_id: string) => {
                    return [node_id, false]
                }
            )
        )
        const current_prompt: any = store.toJsFunc().data.current_prompt
        const loadImageNodes = Object.keys(current_prompt)
            .filter(
                (key: any) => current_prompt[key].class_type === 'LoadImage'
            )
            .reduce(
                (acc, key) => ({
                    ...acc,
                    [key]: current_prompt[key],
                }),
                {}
            )

        Object.keys(loadImageNodes).forEach((node_id: any) => {
            store.data.current_prompt[node_id] = {
                inputs: {
                    image_base64: '',
                },
                class_type: 'LoadImageBase64',
            }
        })

        const node_obj = Object.entries(store.data.current_prompt)
        //clear both node structure and base64 images store values
        store.data.comfyui_valid_nodes = {}
        store.data.uuids = {}
        // store.data.load_image_base64_strings = {}
        node_obj.forEach(([node_id, node]: [string, any]) => {
            console.log(node_id, node)
            const valid_input = parseUIFromNode(node, node_id)
        })
    } catch (e) {
        console.error(e)
    }
}

function setSliderValue(store: any, node_id: string, name: string, value: any) {
    runInAction(() => {
        store.data.current_prompt2[node_id].inputs[name] = value
    })
}
async function onChangeLoadImage(
    node_id: string,
    filename: string,
    type = 'input'
) {
    try {
        store.data.current_uploaded_image[node_id] =
            await util.base64UrlFromComfy({
                filename: encodeURIComponent(filename),
                type: type,
                subfolder: 'Auto-Photoshop-SD',
            })
        store.data.current_prompt2[node_id].inputs.image = `${filename}`
    } catch (e) {
        console.warn(e)
    }
}
async function onChangeLoadVideo(
    node_id: string,
    filename: string,
    type = 'input'
) {
    try {
        store.data.current_uploaded_video[node_id] =
            await util.base64UrlFromComfy({
                filename: encodeURIComponent(filename),
                type: type,
                subfolder: 'Auto-Photoshop-SD',
            })
        store.data.current_prompt2[node_id].inputs.video = filename
    } catch (e) {
        console.warn(e)
    }
}
function renderNode(node_id: string, node: any, is_output: boolean) {
    const comfy_node_info = toJS(store.data.object_info[node.class_type])

    // console.log('comfy_node_info: ', comfy_node_info)
    const node_type = util.getNodeType(node.class_type)
    let node_html

    const inputs = toJS(node.inputs)
    node_html = Object.entries(inputs).map(([name, value], index) => {
        // store.data.current_prompt2[node_id].inputs[name] = value
        try {
            const input = comfy_node_info.input.required[name]

            let { type, config } = util.parseComfyInput(name, input, value)
            if (type === ComfyInputType.Skip) {
                return (
                    <div
                        key={`${node_id}_${name}_${type}_${index}`}
                        style={{ display: 'none' }}
                    ></div>
                )
            }
            const html_element = renderInput(
                node_id,
                name,
                type,
                config,
                `${node_id}_${name}_${type}_${index}`
            )

            return html_element
        } catch (e) {
            console.error(e)
            return (
                <div key={`${node_id}_${name}__${index}` ?? void 0}>
                    {/* {name},{type}, {JSON.stringify(config)} */}
                </div>
            )
        }
    })

    if (node_type === util.ComfyNodeType.LoadImage) {
        const uploaded_images = store.data.uploaded_images_list
        const inputs = store.data.current_prompt2[node_id].inputs
        const node_name = node.class_type
        node_html = (
            <div>
                {/* New load image component */}
                <div>
                    <div>
                        <sp-radio-group
                            style={{ display: 'flex' }}
                            // selected={ }
                            onClick={(event: any) => {
                                store.data.loadImage_loading_method[
                                    node_id
                                ].method = event.target.value
                            }}
                        >
                            <sp-label slot="label">
                                {Locale('Image Loading Method:')}
                            </sp-label>
                            {[
                                'Manual',
                                'Sync From Whole Canvas',
                                'Sync From a Layer',
                            ].map((loading_method: string, index: number) => {
                                return (
                                    <sp-radio
                                        key={`${loading_method}-loading_method-${index}`}
                                        checked={
                                            store.data.loadImage_loading_method[
                                                node_id
                                            ].method === loading_method
                                                ? true
                                                : void 0
                                        }
                                        value={loading_method}
                                    >
                                        {Locale(loading_method)}
                                    </sp-radio>
                                )
                            })}
                        </sp-radio-group>
                    </div>
                    <div
                        style={{
                            display:
                                store.data.loadImage_loading_method[node_id]
                                    .method === 'Manual'
                                    ? void 0
                                    : 'none',
                        }}
                    >
                        <button
                            className="btnSquare "
                            onClick={async () => {
                                const image_base64 =
                                    await io.getImageFromCanvas(false)

                                const image_name =
                                    await reuseOrUploadComfyImage(
                                        image_base64,
                                        store.data
                                            .base64_to_uploaded_images_names,
                                        'input'
                                    )
                                // const new_loaded_image = await util.uploadImage(
                                //     false,
                                //     image_base64,
                                //     'temp'
                                // )
                                // console.log('new_loaded_image: ', new_loaded_image)
                                if (image_name) {
                                    // store.data.uploaded_images_list = [
                                    //     ...store.data.uploaded_images_list,
                                    //     image_name,
                                    // ]

                                    await onChangeLoadImage(
                                        node_id,
                                        image_name,
                                        'input'
                                    )
                                }
                            }}
                        >
                            Load Image From Canvas
                        </button>
                        <button
                            className="btnSquare"
                            onClick={async () => {
                                const new_uploaded_image =
                                    await util.uploadImage(true, '', 'input')
                                console.log(
                                    'new_loaded_image: ',
                                    new_uploaded_image
                                )
                                if (new_uploaded_image) {
                                    store.data.uploaded_images_list = [
                                        ...store.data.uploaded_images_list,
                                        new_uploaded_image.name,
                                    ]
                                    await onChangeLoadImage(
                                        node_id,
                                        new_uploaded_image.name,
                                        'input'
                                    )
                                }
                            }}
                        >
                            Load Image From Folder
                        </button>
                    </div>
                    <div
                        style={{
                            display:
                                store.data.loadImage_loading_method[node_id]
                                    .method === 'Sync From a Layer'
                                    ? void 0
                                    : 'none',
                        }}
                    >
                        <button
                            className="btnSquare"
                            onClick={async () => {
                                const current_layer =
                                    app.activeDocument.activeLayers[0]
                                if (current_layer && current_layer.id) {
                                    store.data.loadImage_loading_method[
                                        node_id
                                    ].data = { layer_id: current_layer.id }
                                    await core.executeAsModal(
                                        async () => {
                                            await SetLayerColor()
                                        },
                                        { commandName: 'Color Code layer' }
                                    )
                                }
                            }}
                        >
                            Sync Current Layer
                        </button>
                    </div>
                </div>
                <sp-label class="title" style={{ display: 'inline-block' }}>
                    {node_name}
                </sp-label>
                <div>
                    <SpMenu
                        disabled={store.data.can_edit_nodes ? true : void 0}
                        size="m"
                        title={node_name}
                        items={uploaded_images}
                        label_item={`Select an Image`}
                        // id={'model_list'}
                        selected_index={uploaded_images.indexOf(inputs.image)}
                        onChange={async (
                            id: any,
                            { index, item }: Record<string, any>
                        ) => {
                            console.log('onChange value.item: ', item)
                            inputs.image = item
                            //load image store for each LoadImage Node
                            //use node_id to store these

                            onChangeLoadImage(node_id, item, 'input')
                        }}
                    ></SpMenu>
                </div>
                <div>
                    <button
                        onClick={() => {
                            let index: number = uploaded_images.indexOf(
                                inputs.image
                            )
                            index--
                            const length = uploaded_images.length
                            index = ((index % length) + length) % length
                            inputs.image = uploaded_images[index]
                            onChangeLoadImage(node_id, inputs.image, 'input')
                        }}
                    >
                        {' '}
                        {'<'}{' '}
                    </button>

                    <button
                        onClick={() => {
                            let index: number = uploaded_images.indexOf(
                                inputs.image
                            )
                            index++
                            const length = uploaded_images.length
                            index = ((index % length) + length) % length
                            inputs.image = uploaded_images[index]
                            onChangeLoadImage(node_id, inputs.image, 'input')
                        }}
                    >
                        {' '}
                        {'>'}{' '}
                    </button>
                </div>
                <img
                    src={store.data.current_uploaded_image[node_id]}
                    style={{ height: '200px' }}
                    onError={async () => {
                        console.error(
                            'error loading image: ',
                            store.data.current_uploaded_image[node_id]
                        )

                        onChangeLoadImage(node_id, inputs.image, 'input')
                    }}
                />
            </div>
        )
    } else if (node_type === util.ComfyNodeType.LoadVideo) {
        //ToDo: rewrite this to support video loading node
        const uploaded_video_list = store.data.uploaded_video_list
        const inputs = store.data.current_prompt2[node_id].inputs
        const node_name = node.class_type
        node_html = (
            <div>
                {/* New load Video component */}
                <div>
                    <button
                        className="btnSquare"
                        onClick={async () => {
                            const new_uploaded_video = await util.uploadImage(
                                true,
                                '',
                                'input'
                            )
                            console.log(
                                'new_uploaded_video: ',
                                new_uploaded_video
                            )
                            if (new_uploaded_video) {
                                store.data.uploaded_video_list = [
                                    ...store.data.uploaded_video_list,
                                    new_uploaded_video.name,
                                ]
                                await onChangeLoadVideo(
                                    node_id,
                                    new_uploaded_video.name,
                                    'input'
                                )
                            }
                        }}
                    >
                        Load Image From Folder
                    </button>
                </div>
                <sp-label class="title" style={{ display: 'inline-block' }}>
                    {node_name}
                </sp-label>
                <div>
                    <SpMenu
                        disabled={store.data.can_edit_nodes ? true : void 0}
                        size="m"
                        title={node_name}
                        items={uploaded_video_list}
                        label_item={`Select a Video`}
                        // id={'model_list'}
                        selected_index={uploaded_video_list.indexOf(
                            inputs.video
                        )}
                        onChange={async (
                            id: any,
                            { index, item }: Record<string, any>
                        ) => {
                            console.log('onChange value.item: ', item)
                            inputs.video = item

                            onChangeLoadVideo(node_id, item)
                        }}
                    ></SpMenu>
                </div>
                <div>
                    <button
                        onClick={() => {
                            let index: number = uploaded_video_list.indexOf(
                                inputs.video
                            )
                            index--
                            const length = uploaded_video_list.length
                            index = ((index % length) + length) % length
                            inputs.video = uploaded_video_list[index]
                            onChangeLoadVideo(node_id, inputs.video)
                        }}
                    >
                        {' '}
                        {'<'}{' '}
                    </button>

                    <button
                        onClick={() => {
                            let index: number = uploaded_video_list.indexOf(
                                inputs.video
                            )
                            index++
                            const length = uploaded_video_list.length
                            index = ((index % length) + length) % length
                            inputs.video = uploaded_video_list[index]
                            onChangeLoadVideo(node_id, inputs.video)
                        }}
                    >
                        {' '}
                        {'>'}{' '}
                    </button>
                </div>
                <img
                    src={store.data.current_uploaded_video[node_id]}
                    style={{ height: '200px' }}
                    onError={async () => {
                        console.error(
                            'error loading video: ',
                            store.data.current_uploaded_video[node_id]
                        )

                        onChangeLoadVideo(node_id, inputs.video)
                    }}
                />
            </div>
        )
    }

    if (is_output) {
        const output_node_element = (
            <div>
                {node_html}
                {store.data.current_prompt2_output[node_id]?.length > 0 ? (
                    <>
                        <SpSlider
                            disabled={store.data.can_edit_nodes ? true : void 0}
                            style={{ display: 'block' }}
                            show-value="false"
                            id="slUpscaleSize"
                            min="25"
                            max="600"
                            value={
                                store.data.output_thumbnail_image_size[node_id]
                            }
                            title=""
                            onInput={(evt: any) => {
                                store.data.output_thumbnail_image_size[
                                    node_id
                                ] = evt.target.value
                            }}
                        >
                            <sp-label slot="label" class="title">
                                Thumbnail Size:
                            </sp-label>
                            <sp-label class="labelNumber" slot="label">
                                {parseInt(
                                    store.data.output_thumbnail_image_size[
                                        node_id
                                    ] as any
                                )}
                            </sp-label>
                        </SpSlider>
                        <sp-checkbox
                            checked={
                                store.data.output_node_fixed_height[node_id]
                                    ? true
                                    : void 0
                            }
                            onClick={(evt: any) => {
                                // store.data.use_sharp_mask = evt.target.checked

                                store.data.output_node_fixed_height[node_id] =
                                    evt.target.checked
                            }}
                        >
                            {Locale('Fixed Height:')}
                        </sp-checkbox>
                    </>
                ) : (
                    void 0
                )}
                <Grid
                    // thumbnails_data={store.data.images}

                    thumbnails={store.data.current_prompt2_output[node_id]}
                    width={store.data.output_thumbnail_image_size[node_id]}
                    height={200}
                    fixedHeight={store.data.output_node_fixed_height[node_id]}
                    action_buttons={[
                        {
                            ComponentType: MoveToCanvasSvg,
                            callback: (index: number) => {
                                let format = util.extractFormat(
                                    store.data.current_prompt2_output[node_id][
                                        index
                                    ]
                                )

                                if (format === 'gif') {
                                    //@ts-ignore
                                    openFileFromUrlExe(
                                        store.data.current_prompt2_output[
                                            node_id
                                        ][index],
                                        format
                                    )
                                } else if (format === 'png') {
                                    urlToCanvas(
                                        store.data.current_prompt2_output[
                                            node_id
                                        ][index],
                                        'comfy_output.png'
                                    )
                                }
                            },
                            title: 'Copy Image to Canvas',
                        },
                        {
                            ComponentType: MoveToCanvasSvg,
                            callback: async (index: number) => {
                                let format = util.extractFormat(
                                    store.data.current_prompt2_output[node_id][
                                        index
                                    ]
                                )

                                if (format === 'png') {
                                    const selectionInfo =
                                        await getSelectionInfoExe()
                                    const image_layer = await moveImageToLayer(
                                        base64UrlToBase64(
                                            store.data.current_prompt2_output[
                                                node_id
                                            ][index]
                                        ),
                                        selectionInfo
                                    )
                                }
                            },
                            title: 'Copy Image to Selection Area',
                        },
                    ]}
                ></Grid>
            </div>
        )

        return output_node_element
    }
    return node_html
}
function renderInput(
    node_id: string,
    name: string,
    type: any,
    config: any,
    key?: string
) {
    let html_element = (
        <div key={key ?? void 0}>
            {name},{type}, {JSON.stringify(config)}
        </div>
    )
    const inputs = store.data.current_prompt2[node_id].inputs

    if (type === util.ComfyInputType.Seed) {
        html_element = (
            <>
                <sp-label slot="label">{name}:</sp-label>
                <sp-textfield
                    disabled={store.data.can_edit_nodes ? true : void 0}
                    // key={key ?? void 0}
                    type="text"
                    // placeholder="cute cats"
                    // value={config.default}
                    value={inputs[name]}
                    onInput={(event: any) => {
                        // store.data.search_query = event.target.value
                        inputs[name] = event.target.value
                        console.log(`${name}: ${event.target.value}`)
                    }}
                ></sp-textfield>
                <button
                    style={{
                        width: '26px',
                    }}
                    className="btnSquare refreshButton"
                    onClick={() => {
                        inputs[name] = util.getRandomBigIntApprox(
                            0n,
                            18446744073709552000n
                        ).toString()
                    }}
                >
                </button>
                <sp-checkbox
                    title="randomize seed before generation"
                    value={store.data.is_random_seed[node_id]}
                    onClick={(evt: any) => {
                        store.data.is_random_seed[node_id] = evt.target.checked
                    }}
                    style={{ display: 'inline-flex',marginLeft: '5px' }}
                >
                    random
                </sp-checkbox>
            </>
        )
    } else if (type === util.ComfyInputType.BigNumber) {
        html_element = (
            <>
                <sp-label slot="label">{name}:</sp-label>
                <sp-textfield
                    disabled={store.data.can_edit_nodes ? true : void 0}
                    // key={key ?? void 0}
                    type="text"
                    // placeholder="cute cats"
                    // value={config.default}
                    value={inputs[name]}
                    onInput={(event: any) => {
                        // store.data.search_query = event.target.value
                        inputs[name] = event.target.value
                        console.log(`${name}: ${event.target.value}`)
                    }}
                ></sp-textfield>
            </>
        )
    } else if (type === util.ComfyInputType.TextFieldNumber) {
        html_element = (
            <>
                <sp-label slot="label">{name}:</sp-label>
                <SpTextfield
                    disabled={store.data.can_edit_nodes ? true : void 0}
                    type="text"
                    // value={config.default}
                    value={inputs[name]}
                    onChange={(e: any) => {
                        const v = e.target.value
                        let new_value =
                            v !== ''
                                ? Math.max(config.min, Math.min(config.max, v))
                                : v
                        inputs[name] = new_value

                        console.log(`${name}: ${e.target.value}`)
                    }}
                ></SpTextfield>
            </>
        )
    } else if (type === util.ComfyInputType.Slider) {
        html_element = (
            <SpSliderWithLabel
                // key={key ?? void 0}
                disabled={store.data.can_edit_nodes ? true : void 0}
                show-value={false}
                steps={config?.step ?? 1}
                out_min={config?.min ?? 0}
                out_max={config?.max ?? 100}
                output_value={store.data.current_prompt2[node_id].inputs[name]}
                label={name}
                slider_type={
                    config?.step && !Number.isInteger(config?.step)
                        ? SliderType.Float
                        : SliderType.Integer
                }
                onSliderInput={(new_value: number) => {
                    // inputs[name] = new_value
                    // setSliderValue(store, node_id, name, new_value)
                    store.data.current_prompt2[node_id].inputs[name] = new_value
                    console.log('slider_change: ', new_value)
                }}
            />
        )
    } else if (type === util.ComfyInputType.Menu) {
        html_element = (
            <>
                <sp-label class="title" style={{ display: 'inline-block' }}>
                    {name}
                </sp-label>
                <SpMenu
                    disabled={store.data.can_edit_nodes ? true : void 0}
                    size="m"
                    title={inputs[name]}
                    items={config}
                    label_item={`Select a ${name}`}
                    // id={'model_list'}
                    selected_index={config.indexOf(inputs[name])}
                    onChange={(
                        id: any,
                        { index, item }: Record<string, any>
                    ) => {
                        console.log('onChange value.item: ', item)
                        inputs[name] = item
                    }}
                ></SpMenu>
            </>
        )
    } else if (type === util.ComfyInputType.TextArea) {
        html_element = (
            <sp-textarea
                disabled={store.data.can_edit_nodes ? true : void 0}
                // key={key}
                onInput={(event: any) => {
                    try {
                        // this.changePositivePrompt(
                        //     event.target.value,
                        //     store.data.current_index
                        // )
                        // autoResize(
                        //     event.target,
                        //     store.data.positivePrompts[
                        //         store.data.current_index
                        //     ]
                        // )
                        inputs[name] = event.target.value
                    } catch (e) {
                        console.warn(e)
                    }
                }}
                placeholder={`${name}`}
                value={inputs[name]}
            ></sp-textarea>
        )
    } else if (type === util.ComfyInputType.TextField) {
        html_element = (
            <>
                <sp-label slot="label">{name}:</sp-label>

                <SpTextfield
                    disabled={store.data.can_edit_nodes ? true : void 0}
                    type="text"
                    // value={config.default}
                    value={inputs[name]}
                    onChange={(e: any) => {
                        inputs[name] = e.target.value
                        console.log(`${name}: ${e.target.value}`)
                    }}
                ></SpTextfield>
            </>
        )
    } else if (type === util.ComfyInputType.CheckBox) {
        html_element = (
            <>
                {/* <sp-label slot="label">{name}:</sp-label> */}

                <sp-checkbox
                    disabled={store.data.can_edit_nodes ? true : void 0}
                    title={name}
                    // value={inputs[name]}
                    checked={inputs[name] ? true : void 0}
                    onClick={(evt: any) => {
                        inputs[name] = evt.target.checked
                    }}
                    style={{ display: 'inline-flex' }}
                >
                    {name}
                </sp-checkbox>
            </>
        )
    }

    return <div key={key}>{html_element}</div>
}

export function swap(index1: number, index2: number) {
    const { length } = store.data.nodes_order
    if (index1 >= 0 && index1 < length && index2 >= 0 && index2 < length) {
        ;[store.data.nodes_order[index1], store.data.nodes_order[index2]] = [
            store.data.nodes_order[index2],
            store.data.nodes_order[index1],
        ]
    }
}

export function moveToTop(index: number) {
    const { length } = store.data.nodes_order
    if (index >= 0 && index < length) {
        const node = store.data.nodes_order[index]
        // Remove the node from its current position
        store.data.nodes_order.splice(index, 1)
        // Add the node to the topmost position
        store.data.nodes_order.unshift(node)
    }
}
export function moveToBottom(index: number) {
    const { length } = store.data.nodes_order
    if (index >= 0 && index < length) {
        const node = store.data.nodes_order[index]
        // Remove the node from its current position
        store.data.nodes_order.splice(index, 1)
        // Add the node to the bottommost position
        store.data.nodes_order.push(node)
    }
}

export function saveWorkflowData(
    workflow_name: string,
    { prompt, nodes_order, nodes_label }: WorkflowData
) {
    storage.localStorage.setItem(
        workflow_name,
        JSON.stringify({ prompt, nodes_order, nodes_label })
    )
}
export function loadWorkflowData(workflow_name: string): WorkflowData {
    const workflow_data: WorkflowData = JSON.parse(
        storage.localStorage.getItem(workflow_name)
    )
    return workflow_data
}
interface WorkflowData {
    prompt: any
    nodes_order: string[]
    nodes_label: Record<string, string>
}

function resetWorkflowData(workflow_name: string) {
    let workflow_data = JSON.parse(storage.localStorage[workflow_name])
    const original_workflow = store.data.workflows2[workflow_name]
    const prompt = toJS(original_workflow)
    workflow_data['prompt'] = prompt

    store.data.current_prompt2 = {}

    storage.localStorage.setItem(workflow_name, JSON.stringify(workflow_data))

    setTimeout(() => {
        loadWorkflow2(toJS(store.data.workflows2[workflow_name]))
    }, 250)
}
function loadWorkflow2(workflow: any) {
    try {
        //1) get prompt
        store.data.current_prompt2 = copyJson(workflow)
        store.data.current_uploaded_image = {}
        // store.data.sync_from_canvas = {}
        store.data.loadImage_loading_method = {}
        store.data.output_node_fixed_height = {}
        //2)  get the original order
        store.data.nodes_order = Object.keys(toJS(store.data.current_prompt2))

        //3) get labels for each nodes
        store.data.nodes_label = Object.fromEntries(
            Object.entries(toJS(store.data.current_prompt2)).map(
                ([node_id, node]: [string, any]) => {
                    if (!(node.class_type in store.data.object_info)) {
                        throw new Error(
                            `ComfyUI Node of type "${node.class_type}" is not found. Please ensure it is installed via the ComfyUI Manager.`
                        )
                    }

                    return [
                        node_id,
                        toJS(store.data.object_info[node.class_type])
                            .display_name,
                    ]
                }
            )
        )
        store.data.is_random_seed = Object.fromEntries(
            Object.keys(toJS(store.data.current_prompt2)).map(
                (node_id: string) => {
                    return [node_id, false]
                }
            )
        )

        for (const node_id in store.data.current_prompt2) {
            if (
                store.data.current_prompt2[node_id].class_type === 'LoadImage'
            ) {
                // store.data.sync_from_canvas[node_id] = true
                store.data.loadImage_loading_method[node_id] = {
                    method: 'Sync From Whole Canvas',
                }
            }
        }

        // parse the output nodes
        // Note: we can't modify the node directly in the prompt like we do for input nodes.
        //.. since this data doesn't exist on the prompt. so we create separate container for the output images
        store.data.current_prompt2_output = Object.entries(
            store.data.current_prompt2
        ).reduce(
            (
                output_entries: Record<string, any[]>,
                [node_id, node]: [string, any]
            ) => {
                if (store.data.object_info[node.class_type].output_node) {
                    output_entries[node_id] = []
                }
                return output_entries
            },
            {}
        )

        //slider variables for output nodes
        //TODO: delete store.data.output_thumbnail_image_size before loading a new workflow
        for (let key in toJS(store.data.current_prompt2_output)) {
            store.data.output_thumbnail_image_size[key] = 200
        }

        const workflow_name = store.data.selected_workflow_name
        if (workflow_name) {
            // check if the workflow has a name

            if (workflow_name in storage.localStorage) {
                //load the workflow data from local storage
                //1) load the last parameters used in generation
                //2) load the order of the nodes
                //3) load the labels of the nodes

                const workflow_data: WorkflowData =
                    loadWorkflowData(workflow_name)
                if (
                    util.isSameStructure(
                        workflow_data.prompt,
                        toJS(store.data.current_prompt2)
                    )
                ) {
                    //load 1)
                    store.data.current_prompt2 = workflow_data.prompt
                    //load 2)
                    store.data.nodes_order = workflow_data.nodes_order
                    //load 3)
                    store.data.nodes_label = workflow_data.nodes_label
                } else {
                    // do not load. instead override the localStorage with the new values
                    workflow_data.prompt = toJS(store.data.current_prompt2)
                    workflow_data.nodes_order = toJS(store.data.nodes_order)
                    workflow_data.nodes_label = toJS(store.data.nodes_label)

                    saveWorkflowData(workflow_name, workflow_data)
                }
            } else {
                // if workflow data is missing from local storage then save it for next time.
                //1) save parameters values
                //2) save nodes order
                //3) save nodes label

                const prompt = toJS(store.data.current_prompt2)
                const nodes_order = toJS(store.data.nodes_order)
                const nodes_label = toJS(store.data.nodes_label)
                saveWorkflowData(workflow_name, {
                    prompt,
                    nodes_order,
                    nodes_label,
                })
            }
        }
    } catch (e) {
        console.error(e)
        app.showAlert(`${e}`)
    }
}

async function getUploadedImages(images_list: string[]) {
    //convert all of comfyui loaded images into base64url that the plugin can use
    let uploaded_images = images_list

    uploaded_images = uploaded_images.filter((image_name: string) => {
        let extension = image_name.split('.').pop() || ''
        // return extension !== 'gif' && extension !== 'mp4'
        return ['png', 'jpg', 'webp'].includes(extension)
    })

    const uploaded_images_base64_url: string[] = await Promise.all(
        uploaded_images.map(async (filename: string) => {
            try {
                return await util.base64UrlFromComfy({
                    filename: encodeURIComponent(filename),
                    type: 'input',
                    subfolder: 'Auto-Photoshop-SD',
                })
            } catch (e) {
                console.warn(e)
                return ''
            }
        })
    )
    store.data.uploaded_images_list =
        store.data.object_info.LoadImage.input.required['image'][0]

    store.data.uploaded_images_base64_url = uploaded_images_base64_url
    return store.data.uploaded_images_base64_url
}

function getBorderColor(is_output: boolean, last_moved: boolean) {
    let color: string | undefined = void 0
    if (last_moved) {
        // color = '#2c4639'
        color = '#e34d12'

        return color
    }
    if (is_output) {
        // color = '#e34d12'
        color = '#6db579'
    } else {
        color = '#6d6c6c'
    }

    return color
}
@observer
class ComfyWorkflowComponent extends React.Component<{}, { value?: number }> {
    async componentDidMount(): Promise<void> {
        try {
            store.data.object_info = await comfyapi.comfy_api.init()
            // getUploadedImages(
            //     store.data.object_info.LoadImage.input.required['image'][0]
            // )
            if (store.data.object_info?.VHS_LoadVideo) {
                store.data.uploaded_video_list =
                    store.data.object_info.VHS_LoadVideo.input.required[
                        'video'
                    ][0]
            }
        } catch (e) {
            console.error(e)
        }
    }

    render(): React.ReactNode {
        return (
            <div>
                <div
                    style={{ display: 'flex', justifyContent: 'space-between' }}
                >
                    {/* {util.getNodes(util.hi_res_workflow).map((node, index) => {
                    // return <div>{node.class_type}</div>
                    return (
                        <div key={'node_' + index}>{this.renderNode(node)}</div>
                    )
                })} */}
                    <button
                        className="btnSquare"
                        style={{
                            display: store.data.can_generate ? void 0 : 'none',
                        }}
                        onClick={async () => {
                            // let interval
                            store.data.can_generate = false
                            let interval: NodeJS.Timeout = setInterval(
                                function () {
                                    store.data.progress_value++
                                    console.log(store.data.progress_value)
                                },
                                1000
                            ) // 1000 milliseconds = 1 second
                            try {
                                // Start the progress update

                                util.runRandomSeedScript()
                                let { outputs, separated_outputs } =
                                    await util.postPromptAndGetBase64JsonResult(
                                        toJS(store.data.current_prompt2)
                                    )
                                store.data.current_prompt2_output =
                                    outputs ?? {}
                            } catch (e) {
                                console.error(e)
                            } finally {
                                clearInterval(interval as NodeJS.Timeout)
                                store.data.progress_value = 0
                                store.data.can_generate = true
                            }
                        }}
                    >
                        Generate
                    </button>
                    <button
                        className="btnSquare"
                        style={{
                            display: store.data.can_generate ? void 0 : 'none',
                        }}
                        onClick={async () => {
                            store.data.infinite_loop = true

                            async function infiniteCanvasImageScript() {
                                try {
                                    let numOfImagesToSync = 0
                                    // for (const node_id in store.data
                                    //     .sync_from_canvas) {
                                    for (const node_id in store.data
                                        .loadImage_loading_method) {
                                        if (
                                            // store.data.sync_from_canvas[node_id]
                                            store.data.loadImage_loading_method[
                                                node_id
                                            ].method ===
                                            'Sync From Whole Canvas'
                                        ) {
                                            numOfImagesToSync += 1
                                        }
                                    }

                                    if (numOfImagesToSync === 0) {
                                        // return undefined
                                        //
                                    } else {
                                        //debounce if the function executed recently
                                        const now = Date.now()
                                        if (now - store.data.lastCall < 2000) {
                                            console.log(
                                                'getImageFromCanvas debounced'
                                            )
                                            // return undefined
                                        } else {
                                            store.data.lastCall = now

                                            const image_data_url =
                                                await getImageFromCanvas_new()

                                            const image_base64 =
                                                base64UrlToBase64(
                                                    image_data_url!
                                                )

                                            const image_name =
                                                await reuseOrUploadComfyImage(
                                                    image_base64,
                                                    store.data
                                                        .base64_to_uploaded_images_names,
                                                    'input'
                                                )
                                            if (image_name) {
                                                for (const node_id of Object.keys(
                                                    // store.data.sync_from_canvas
                                                    store.data
                                                        .loadImage_loading_method
                                                )) {
                                                    if (
                                                        store.data
                                                            .loadImage_loading_method[
                                                            node_id
                                                        ].method ===
                                                        'Sync From Whole Canvas'
                                                    ) {
                                                        await onChangeLoadImage(
                                                            node_id,
                                                            image_name,
                                                            'input'
                                                        )
                                                    }
                                                }
                                            }
                                        }
                                    }

                                    // sync from layer

                                    for (const node_id in store.data
                                        .loadImage_loading_method) {
                                        try {
                                            if (
                                                store.data
                                                    .loadImage_loading_method[
                                                    node_id
                                                ].method === 'Sync From a Layer'
                                            ) {
                                                const layer_id =
                                                    store.data
                                                        .loadImage_loading_method[
                                                        node_id
                                                    ].data?.layer_id
                                                const layer_data_url =
                                                    await getImageFromCanvas_new(
                                                        layer_id!
                                                    )
                                                const layer_image_base64 =
                                                    base64UrlToBase64(
                                                        layer_data_url!
                                                    )

                                                const image_name =
                                                    await reuseOrUploadComfyImage(
                                                        layer_image_base64,
                                                        store.data
                                                            .base64_to_uploaded_images_names,
                                                        'input'
                                                    )
                                                if (image_name) {
                                                    await onChangeLoadImage(
                                                        node_id,
                                                        image_name,
                                                        'input'
                                                    )
                                                }
                                            }
                                        } catch (e) {
                                            console.error(e)
                                            if (!isValidVersion(25)) {
                                                // const errorMessage = `Real-time img2img Require Adobe Photoshop version 25 or higher. Your current version is ${host.version}. Please update Adobe Photoshop to use this feature. You can still use realtime txt2img.`
                                                // app.showAlert(errorMessage)
                                                throw e
                                            }
                                        }
                                    }
                                } catch (e) {
                                    console.error(e)
                                    if (!isValidVersion(25)) {
                                        const errorMessage = `Real-time img2img Require Adobe Photoshop version 25 or higher. Your current version is ${host.version}. Please update Adobe Photoshop to use this feature. You can still use realtime txt2img.`
                                        app.showAlert(errorMessage)
                                        throw errorMessage
                                    }
                                    throw e
                                }
                            }
                            while (store.data.infinite_loop) {
                                store.data.can_generate = false
                                let interval: NodeJS.Timeout = setInterval(
                                    function () {
                                        store.data.progress_value++
                                        console.log(store.data.progress_value)
                                    },
                                    1000
                                ) // 1000 milliseconds = 1 second

                                try {
                                    // Start the progress update

                                    util.runRandomSeedScript()
                                    await infiniteCanvasImageScript()

                                    let { outputs, separated_outputs } =
                                        await util.postPromptAndGetBase64JsonResult(
                                            toJS(store.data.current_prompt2)
                                        )
                                    store.data.current_prompt2_output =
                                        outputs ?? {}
                                } catch (e) {
                                    console.error(e)
                                    break
                                } finally {
                                    clearInterval(interval as NodeJS.Timeout)
                                    store.data.progress_value = 0
                                    store.data.can_generate = true
                                }
                            }
                        }}
                    >
                        Generate RealTime
                    </button>
                    <button
                        className="btnSquare"
                        style={{
                            display: !store.data.can_generate ? void 0 : 'none',
                        }}
                        onClick={async () => {
                            await comfyapi.comfy_api.interrupt()
                            store.data.infinite_loop = false
                        }}
                    >
                        Interrupt
                    </button>
                    <button
                        className="btnSquare"
                        style={{
                            display: store.data.can_edit_nodes
                                ? void 0
                                : 'none',
                        }}
                        onClick={async () => {
                            resetWorkflowData(store.data.selected_workflow_name)
                        }}
                    >
                        Reset Workflow
                    </button>
                    <button
                        className="btnSquare"
                        onClick={async () => {
                            store.data.last_moved = void 0
                            store.data.can_edit_nodes =
                                !store.data.can_edit_nodes

                            const workflow_name =
                                store.data.selected_workflow_name
                            const prompt = toJS(store.data.current_prompt2)
                            const nodes_order = toJS(store.data.nodes_order)
                            const nodes_label = toJS(store.data.nodes_label)

                            saveWorkflowData(workflow_name, {
                                prompt,
                                nodes_order,
                                nodes_label,
                            })
                        }}
                    >
                        {store.data.can_edit_nodes
                            ? 'Done Editing'
                            : 'Edit Nodes'}
                    </button>
                </div>
                <div>
                    <sp-progressbar
                        class="pProgressBars preview_progress_bar"
                        max="100"
                        value={`${store.data.progress_value}`}
                    ></sp-progressbar>
                </div>
                <div>
                    <SpMenu
                        size="m"
                        title="workflows"
                        items={Object.keys(store.data.workflows2)}
                        label_item="Select a workflow"
                        selected_index={Object.values(
                            store.data.workflows2
                        ).indexOf(store.data.selected_workflow_name)}
                        onChange={async (id: any, value: any) => {
                            store.data.selected_workflow_name = value.item
                            loadWorkflow2(store.data.workflows2[value.item])
                        }}
                    ></SpMenu>{' '}
                    <button
                        className="btnSquare refreshButton btnResetSettings"
                        title="reload the current workflow"
                        onClick={async () => {
                            store.data.object_info =
                                await comfyapi.comfy_api.init(true)

                            store.data.current_prompt2 = {}

                            setTimeout(() => {
                                loadWorkflow2(
                                    toJS(
                                        store.data.workflows2[
                                            store.data.selected_workflow_name
                                        ]
                                    )
                                )
                            }, 250)
                        }}
                    ></button>
                    <button
                        className="btnSquare"
                        style={{ marginLeft: '3px' }}
                        onClick={async () => {
                            try {
                                const entries = await workflowEntries()

                                if (entries.length > 0) {
                                    store.data.user_custom_workflow = {}
                                    for (const entry of entries) {
                                        const json = JSON.parse(
                                            await entry.read({
                                                format: storage.formats.utf8,
                                            })
                                        )
                                        const workflow_name =
                                            entry.name.split('.json')[0]
                                        store.data.user_custom_workflow[
                                            workflow_name
                                        ] = json
                                    }

                                    store.data.workflows2 = {
                                        // ...store.data.workflows2,
                                        ...store.data.user_custom_workflow,
                                    }
                                }
                            } catch (e) {
                                console.error(e)
                            }
                        }}
                    >
                        Load
                    </button>
                </div>

                {store.data.object_info ? (
                    <>
                        <div>
                            {util
                                .getNodes(store.data.current_prompt2)
                                .sort(
                                    ([node_id1, node1], [node_id2, node2]) => {
                                        if (node1?._meta?.title && (node1._meta.title).toLowerCase().includes('sort') && node2?._meta?.title && (node2._meta.title).toLowerCase().includes('sort')) {
                                            let match1 = (node1._meta.title).match(/[S|s]ort(\d+)/)
                                            let match2 = (node2._meta.title).match(/[S|s]ort(\d+)/)
                                            if (match1 && match2) {
                                                return Number(match1[1]) - Number(match2[1])
                                            }
                                        } else if (node1?._meta?.title && (node1._meta.title).toLowerCase().includes('sort')) {
                                            return -1
                                        } else if (node2?._meta?.title && (node2._meta.title).toLowerCase().includes('sort')) {
                                            return 1
                                        }
                                        return (
                                            store.data.nodes_order.indexOf(
                                                node_id1
                                            ) -
                                            store.data.nodes_order.indexOf(
                                                node_id2
                                            )
                                        )
                                    }
                                )

                                .map(([node_id, node], index) => {
                                    try {
                                        const is_output =
                                            store.data.object_info[
                                                node.class_type
                                            ].output_node
                                        if (!node._meta || (node._meta && !node._meta.title) || (node?._meta?.title && !(node._meta.title).toLowerCase().includes('sort'))) {
                                            return (
                                                ''
                                            )
                                        }
                                        return (
                                            <div
                                                key={`node_${node_id}_${index}`}
                                                style={{
                                                    border: '2px solid #6d6c6c',
                                                    borderColor: getBorderColor(
                                                        is_output,
                                                        store.data
                                                            .last_moved ===
                                                            node_id
                                                    ),

                                                    padding: '3px',
                                                }}
                                            >
                                                <div
                                                    style={{
                                                        display: store.data
                                                            .can_edit_nodes
                                                            ? 'flex'
                                                            : 'none',
                                                        flexDirection: 'row',
                                                        justifyContent:
                                                            'space-between',
                                                    }}
                                                >
                                                    <div
                                                        style={{
                                                            display: 'flex',
                                                            flexDirection:
                                                                'column',
                                                            alignItems:
                                                                'flex-start',
                                                        }}
                                                    >
                                                        <button
                                                            id={`${node_id}_new_button_1`}
                                                            style={{
                                                                width: '26px',
                                                            }}
                                                            title={
                                                                'move node to the first position'
                                                            }
                                                            className="btnSquare"
                                                            onClick={(
                                                                e: any
                                                            ) => {
                                                                store.data.last_moved =
                                                                    node_id
                                                                moveToTop(index)
                                                            }}
                                                        >
                                                            {' '}
                                                            {'▲▲'}{' '}
                                                        </button>
                                                        <button
                                                            id={`${node_id}_new_button_2`}
                                                            style={{
                                                                width: '26px',
                                                            }}
                                                            title={
                                                                'move node to the last position'
                                                            }
                                                            className="btnSquare"
                                                            onClick={() => {
                                                                store.data.last_moved =
                                                                    node_id
                                                                moveToBottom(
                                                                    index
                                                                )
                                                            }}
                                                        >
                                                            {' '}
                                                            {'▼▼'}{' '}
                                                        </button>
                                                    </div>
                                                    <div
                                                        style={{
                                                            display: 'flex',
                                                            flexDirection:
                                                                'column',
                                                            alignItems:
                                                                'flex-end',
                                                        }}
                                                    >
                                                        <button
                                                            id={`${node_id}_swap_up`}
                                                            style={{
                                                                width: '26px',
                                                            }}
                                                            className="btnSquare"
                                                            onClick={(
                                                                e: any
                                                            ) => {
                                                                store.data.last_moved =
                                                                    node_id
                                                                console.log(
                                                                    'node_id assign to the swap button: ',
                                                                    node_id
                                                                )
                                                                swap(
                                                                    index,
                                                                    index - 1
                                                                )
                                                            }}
                                                        >
                                                            {' '}
                                                            {'▲'}{' '}
                                                        </button>
                                                        <button
                                                            id={`${node_id}_swap_down`}
                                                            style={{
                                                                width: '26px',
                                                            }}
                                                            className="btnSquare"
                                                            onClick={() => {
                                                                store.data.last_moved =
                                                                    node_id
                                                                swap(
                                                                    index,
                                                                    index + 1
                                                                )
                                                            }}
                                                        >
                                                            {' '}
                                                            {'▼'}{' '}
                                                        </button>
                                                    </div>
                                                </div>
                                                <sp-label>
                                                    "{node_id}":{' '}
                                                    <span
                                                        style={{
                                                            color: store.data
                                                                .can_edit_nodes
                                                                ? 'white'
                                                                : void 0,
                                                        }}
                                                    >
                                                        {
                                                            node?._meta?.title || store.data
                                                                .nodes_label[
                                                                node_id
                                                            ]
                                                        }
                                                    </span>{' '}
                                                </sp-label>{' '}
                                                <sp-label
                                                    style={{
                                                        display: store.data
                                                            .can_edit_nodes
                                                            ? void 0
                                                            : 'none',
                                                    }}
                                                >
                                                    {node.class_type}
                                                </sp-label>
                                                <div
                                                    style={{
                                                        display: !store.data
                                                            .can_edit_nodes
                                                            ? 'none'
                                                            : void 0,
                                                    }}
                                                >
                                                    <sp-textfield
                                                        type="text"
                                                        placeholder="write a node label"
                                                        value={
                                                            store.data
                                                                .nodes_label[
                                                                node_id
                                                            ]
                                                        }
                                                        onInput={(
                                                            event: any
                                                        ) => {
                                                            store.data.nodes_label[
                                                                node_id
                                                            ] =
                                                                event.target.value
                                                        }}
                                                    ></sp-textfield>
                                                </div>
                                                {renderNode(
                                                    node_id,
                                                    node,
                                                    is_output
                                                )}
                                            </div>
                                        )
                                    } catch (e) {
                                        console.error(
                                            `node_id: ${node_id}`,
                                            'node:',
                                            toJS(node),
                                            'node.class_type',
                                            node.class_type,
                                            'store.data.object_info[node.class_type]: ',
                                            store.data.object_info[
                                                node.class_type
                                            ],
                                            'error: ',
                                            e
                                        )
                                        return (
                                            <sp-label
                                                id=""
                                                style={{
                                                    color: '#ff595e',
                                                    whiteSpace: 'normal',
                                                }}
                                            >
                                                {Locale(
                                                    `Error: Node ${node.class_type} is
                                                missing, please install it from
                                                comfyui manager`
                                                )}
                                            </sp-label>
                                        )
                                    }
                                })}
                        </div>
                    </>
                ) : (
                    void 0
                )}
            </div>
        )
    }
}
const container = document.getElementById('ComfyUIContainer')!
const root = ReactDOM.createRoot(container)
root.render(
    //<React.StrictMode>
    <ErrorBoundary>
        <div style={{ border: '2px solid #6d6c6c', padding: '3px' }}>
            <Collapsible
                defaultIsOpen={true}
                label={Locale('Custom ComfyUI Workflow')}
            >
                {/* <ComfyNodeComponent></ComfyNodeComponent> */}

                <ComfyWorkflowComponent />
            </Collapsible>
        </div>
        {/* <ComfyNodeComponent></ComfyNodeComponent> */}
    </ErrorBoundary>
    //</React.StrictMode>
)
