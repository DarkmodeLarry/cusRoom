"use strict";
(() => {
var exports = {};
exports.id = 522;
exports.ids = [522];
exports.modules = {

/***/ 7783:
/***/ ((module) => {

module.exports = require("next/dist/compiled/@edge-runtime/cookies");

/***/ }),

/***/ 8530:
/***/ ((module) => {

module.exports = require("next/dist/compiled/@opentelemetry/api");

/***/ }),

/***/ 4426:
/***/ ((module) => {

module.exports = require("next/dist/compiled/chalk");

/***/ }),

/***/ 252:
/***/ ((module) => {

module.exports = require("next/dist/compiled/cookie");

/***/ }),

/***/ 1225:
/***/ ((__unused_webpack_module, __webpack_exports__, __webpack_require__) => {

// ESM COMPAT FLAG
__webpack_require__.r(__webpack_exports__);

// EXPORTS
__webpack_require__.d(__webpack_exports__, {
  headerHooks: () => (/* binding */ headerHooks),
  originalPathname: () => (/* binding */ originalPathname),
  requestAsyncStorage: () => (/* binding */ requestAsyncStorage),
  routeModule: () => (/* binding */ routeModule),
  serverHooks: () => (/* binding */ serverHooks),
  staticGenerationAsyncStorage: () => (/* binding */ staticGenerationAsyncStorage),
  staticGenerationBailout: () => (/* binding */ staticGenerationBailout)
});

// NAMESPACE OBJECT: ./app/generate/route.ts
var route_namespaceObject = {};
__webpack_require__.r(route_namespaceObject);
__webpack_require__.d(route_namespaceObject, {
  POST: () => (POST)
});

// EXTERNAL MODULE: ./node_modules/.pnpm/next@13.4.7_ob7c7ogpcitikph4afkm5ompve/node_modules/next/dist/server/node-polyfill-headers.js
var node_polyfill_headers = __webpack_require__(7778);
// EXTERNAL MODULE: ./node_modules/.pnpm/next@13.4.7_ob7c7ogpcitikph4afkm5ompve/node_modules/next/dist/server/future/route-modules/app-route/module.js
var app_route_module = __webpack_require__(9378);
var module_default = /*#__PURE__*/__webpack_require__.n(app_route_module);
// EXTERNAL MODULE: ./node_modules/.pnpm/@upstash+ratelimit@0.3.10/node_modules/@upstash/ratelimit/dist/index.js
var dist = __webpack_require__(7645);
// EXTERNAL MODULE: ./node_modules/.pnpm/@upstash+redis@1.21.0/node_modules/@upstash/redis/esm/platforms/nodejs.js + 154 modules
var nodejs = __webpack_require__(4252);
;// CONCATENATED MODULE: ./utils/redis.ts

const redis = !!process.env.UPSTASH_REDIS_REST_URL && !!process.env.UPSTASH_REDIS_REST_TOKEN ? new nodejs/* Redis */.s({
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN
}) : undefined;
/* harmony default export */ const utils_redis = (redis);

// EXTERNAL MODULE: ./node_modules/.pnpm/next@13.4.7_ob7c7ogpcitikph4afkm5ompve/node_modules/next/dist/server/web/exports/next-response.js
var next_response = __webpack_require__(3431);
// EXTERNAL MODULE: ./node_modules/.pnpm/next@13.4.7_ob7c7ogpcitikph4afkm5ompve/node_modules/next/headers.js
var headers = __webpack_require__(4604);
;// CONCATENATED MODULE: ./app/generate/route.ts




// Create a new ratelimiter, that allows 5 requests per 24 hours
const ratelimit = utils_redis ? new dist.Ratelimit({
    redis: utils_redis,
    limiter: dist.Ratelimit.fixedWindow(5, "1440 m"),
    analytics: true
}) : undefined;
async function POST(request) {
    // Rate Limiter Code
    if (ratelimit) {
        const headersList = (0,headers.headers)();
        const ipIdentifier = headersList.get("x-real-ip");
        const result = await ratelimit.limit(ipIdentifier ?? "");
        if (!result.success) {
            return new Response("Too many uploads in 1 day. Please try again in a 24 hours.", {
                status: 429,
                headers: {
                    "X-RateLimit-Limit": result.limit,
                    "X-RateLimit-Remaining": result.remaining
                }
            });
        }
    }
    const { imageUrl, theme, room } = await request.json();
    // POST request to Replicate to start the image restoration generation process
    let startResponse = await fetch("https://api.replicate.com/v1/predictions", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Authorization: "Token " + process.env.REPLICATE_API_KEY
        },
        body: JSON.stringify({
            version: "854e8727697a057c525cdb45ab037f64ecca770a1769cc52287c2e56472a247b",
            input: {
                image: imageUrl,
                prompt: room === "Gaming Room" ? "a room for gaming with gaming computers, gaming consoles, and gaming chairs" : `a ${theme.toLowerCase()} ${room.toLowerCase()}`,
                a_prompt: "best quality, extremely detailed, photo from Pinterest, interior, cinematic photo, ultra-detailed, ultra-realistic, award-winning",
                n_prompt: "longbody, lowres, bad anatomy, bad hands, missing fingers, extra digit, fewer dis, cropped, worst quality, low quality"
            }
        })
    });
    let jsonStartResponse = await startResponse.json();
    let endpointUrl = jsonStartResponse.urls.get;
    // GET request to get the status of the image restoration process & return the result when it's ready
    let restoredImage = null;
    while(!restoredImage){
        // Loop in 1s intervals until the alt text is ready
        console.log("polling for result...");
        let finalResponse = await fetch(endpointUrl, {
            method: "GET",
            headers: {
                "Content-Type": "application/json",
                Authorization: "Token " + process.env.REPLICATE_API_KEY
            }
        });
        let jsonFinalResponse = await finalResponse.json();
        if (jsonFinalResponse.status === "succeeded") {
            restoredImage = jsonFinalResponse.output;
        } else if (jsonFinalResponse.status === "failed") {
            break;
        } else {
            await new Promise((resolve)=>setTimeout(resolve, 1000));
        }
    }
    return next_response/* default */.Z.json(restoredImage ? restoredImage : "Failed to restore image");
}

;// CONCATENATED MODULE: ./node_modules/.pnpm/next@13.4.7_ob7c7ogpcitikph4afkm5ompve/node_modules/next/dist/build/webpack/loaders/next-app-loader.js?page=%2Fgenerate%2Froute&name=app%2Fgenerate%2Froute&pagePath=private-next-app-dir%2Fgenerate%2Froute.ts&appDir=%2FUsers%2Flarryly%2FCode%2FTemplates%2Fclones%2Fcussroom%2Fapp&appPaths=%2Fgenerate%2Froute&pageExtensions=tsx&pageExtensions=ts&pageExtensions=jsx&pageExtensions=js&basePath=&assetPrefix=&nextConfigOutput=&preferredRegion=&middlewareConfig=e30%3D!

    

    

    

    const options = {"definition":{"kind":"APP_ROUTE","page":"/generate/route","pathname":"/generate","filename":"route","bundlePath":"app/generate/route"},"resolvedPagePath":"/Users/larryly/Code/Templates/clones/cussroom/app/generate/route.ts","nextConfigOutput":""}
    const routeModule = new (module_default())({
      ...options,
      userland: route_namespaceObject,
    })

    // Pull out the exports that we need to expose from the module. This should
    // be eliminated when we've moved the other routes to the new format. These
    // are used to hook into the route.
    const {
      requestAsyncStorage,
      staticGenerationAsyncStorage,
      serverHooks,
      headerHooks,
      staticGenerationBailout
    } = routeModule

    const originalPathname = "/generate/route"

    

/***/ })

};
;

// load runtime
var __webpack_require__ = require("../../webpack-runtime.js");
__webpack_require__.C(exports);
var __webpack_exec__ = (moduleId) => (__webpack_require__(__webpack_require__.s = moduleId))
var __webpack_exports__ = __webpack_require__.X(0, [18,576], () => (__webpack_exec__(1225)));
module.exports = __webpack_exports__;

})();