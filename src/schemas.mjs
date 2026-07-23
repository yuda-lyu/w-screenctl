import Joi from 'joi'


// 共用片段
const sCoord = Joi.number().integer().min(-50000).max(50000)
const sSize = Joi.number().integer().min(1).max(50000)
const sButton = Joi.number().integer().valid(1, 2, 3).default(1)
const sAmount = Joi.number().integer().min(1).max(100).default(3)
const sDirSys = Joi.string().valid('up', 'down').required()
const sDirChrome = Joi.string().valid('up', 'down', 'left', 'right').required()
const sUrl = Joi.string().uri({ scheme: ['http', 'https', 'about', 'file'] }).required()
const sNonEmptyStr = Joi.string().min(1).max(100000).required()
const sKeys = Joi.string().min(1).max(200).required()
const sRegion = Joi.object({
    x: sCoord.required(),
    y: sCoord.required(),
    width: sSize.required(),
    height: sSize.required(),
})
const sWindow = Joi.object({
    x: sCoord.optional(),
    y: sCoord.optional(),
    width: sSize.optional(),
    height: sSize.optional(),
}).and('x', 'y').and('width', 'height')
const sViewport = Joi.object({
    width: sSize.required(),
    height: sSize.required(),
})

// /chrome/open
//   userData：caller 想覆寫 server 預設 user data 路徑時使用；不送則用 server 啟動時定的 fdUserData
export const schemaChromeOpen = Joi.object({
    url: Joi.string().uri({ scheme: ['http', 'https', 'about', 'file'] }).optional(),
    mode: Joi.string().valid('reuse', 'replace').optional(),
    window: sWindow.optional(),
    viewport: sViewport.optional(),
    userData: Joi.string().optional(),
    opt: Joi.object({
        headless: Joi.boolean().default(true),
        disableGpu: Joi.boolean().default(false),
        disableSandbox: Joi.boolean().default(false),
        deviceScaleFactor: Joi.number().positive().optional(),
    }).default({}),
})

// /chrome/navigate
export const schemaChromeNavigate = Joi.object({ url: sUrl })

// /chrome/evaluate
export const schemaChromeEvaluate = Joi.object({ script: sNonEmptyStr })

// 系統級截圖
export const schemaSystemScreenshot = Joi.object({ region: sRegion.optional() })

// 系統級滑鼠
export const schemaSystemMouseClick = Joi.object({
    x: sCoord.required(), y: sCoord.required(), button: sButton,
})
export const schemaSystemMouseDblClick = Joi.object({
    x: sCoord.required(), y: sCoord.required(),
})
export const schemaSystemMouseDrag = Joi.object({
    fromX: sCoord.required(),
    fromY: sCoord.required(),
    toX: sCoord.required(),
    toY: sCoord.required(),
    button: sButton,
})
export const schemaSystemMouseScroll = Joi.object({
    x: sCoord.required(),
    y: sCoord.required(),
    direction: sDirSys,
    amount: sAmount,
})

// 系統級鍵盤
export const schemaSystemKeyboardKey = Joi.object({ keys: sKeys })
export const schemaSystemKeyboardType = Joi.object({
    text: Joi.string().min(0).max(100000).required(),
})

// Chrome 頁面級滑鼠
export const schemaChromeMouseClick = Joi.object({
    x: sCoord.required(), y: sCoord.required(), button: sButton,
})
export const schemaChromeMouseDblClick = Joi.object({
    x: sCoord.required(), y: sCoord.required(),
})
export const schemaChromeMouseDrag = Joi.object({
    fromX: sCoord.required(),
    fromY: sCoord.required(),
    toX: sCoord.required(),
    toY: sCoord.required(),
    button: sButton,
})
export const schemaChromeMouseScroll = Joi.object({
    x: sCoord.required(),
    y: sCoord.required(),
    direction: sDirChrome,
    amount: sAmount,
})

// Chrome 頁面級鍵盤
export const schemaChromeKeyboardKey = Joi.object({ keys: sKeys })
export const schemaChromeKeyboardType = Joi.object({
    text: Joi.string().min(0).max(100000).required(),
})
