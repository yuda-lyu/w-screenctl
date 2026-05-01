import rollupFiles from 'w-package-tools/src/rollupFiles.mjs'
import getFiles from 'w-package-tools/src/getFiles.mjs'


let fdSrc = './src'
let fdTar = './dist'


rollupFiles({
    fns: getFiles(fdSrc),
    fdSrc,
    fdTar,
    nameDistType: 'kebabCase',
    globals: {
        'path': 'path',
        'fs': 'fs',
        'os': 'os',
        'util':'util',
        'crypto':'crypto',
        'child_process': 'child_process',
        '@hapi/hapi': '@hapi/hapi',
        'joi':'joi',
        'playwright': 'playwright',
        'sharp': 'sharp',
        'screenshot-desktop': 'screenshot-desktop',
        '@techstark/opencv-js': '@techstark/opencv-js',
    },
    external: [
        'path',
        'fs',
        'os',
        'util',
        'crypto',
        'child_process',
        '@hapi/hapi',
        'joi',
        'playwright',
        'sharp',
        'screenshot-desktop',
        '@techstark/opencv-js',
    ],
})
