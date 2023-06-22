"use strict";
exports.id = 576;
exports.ids = [576];
exports.modules = {

/***/ 5797:
/***/ ((module) => {


var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all)=>{
    for(var name in all)__defProp(target, name, {
        get: all[name],
        enumerable: true
    });
};
var __copyProps = (to, from, except, desc)=>{
    if (from && typeof from === "object" || typeof from === "function") {
        for (let key of __getOwnPropNames(from))if (!__hasOwnProp.call(to, key) && key !== except) __defProp(to, key, {
            get: ()=>from[key],
            enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
        });
    }
    return to;
};
var __toCommonJS = (mod)=>__copyProps(__defProp({}, "__esModule", {
        value: true
    }), mod);
// src/index.ts
var src_exports = {};
__export(src_exports, {
    Analytics: ()=>Analytics
});
module.exports = __toCommonJS(src_exports);
// src/analytics.ts
var Key = class {
    constructor(prefix, table, bucket){
        this.prefix = prefix;
        this.table = table;
        this.bucket = bucket;
    }
    toString() {
        return [
            this.prefix,
            this.table,
            this.bucket
        ].join(":");
    }
    static fromString(key) {
        const [prefix, table, bucket] = key.split(":");
        return new Key(prefix, table, parseInt(bucket));
    }
};
var Cache = class {
    constructor(ttl){
        this.cache = /* @__PURE__ */ new Map();
        this.ttl = ttl;
        setInterval(()=>{
            const now = Date.now();
            for (const [key, { createdAt }] of this.cache){
                if (now - createdAt > this.ttl) {
                    this.cache.delete(key);
                }
            }
        }, this.ttl * 10);
    }
    get(key) {
        const data = this.cache.get(key);
        if (!data) {
            return null;
        }
        if (Date.now() - data.createdAt > this.ttl) {
            this.cache.delete(key);
            return null;
        }
        return data.value;
    }
    set(key, value) {
        this.cache.set(key, {
            createdAt: Date.now(),
            value
        });
    }
};
var Analytics = class {
    constructor(config){
        this.cache = new Cache(6e4);
        this.redis = config.redis;
        this.prefix = config.prefix ?? "@upstash/analytics";
        this.bucketSize = this.parseWindow(config.window);
        this.retention = config.retention ? this.parseWindow(config.retention) : void 0;
    }
    validateTableName(table) {
        const regex = /^[a-zA-Z0-9_-]+$/;
        if (!regex.test(table)) {
            throw new Error(`Invalid table name: ${table}. Table names can only contain letters, numbers, dashes and underscores.`);
        }
    }
    parseWindow(window) {
        if (typeof window === "number") {
            if (window <= 0) {
                throw new Error(`Invalid window: ${window}`);
            }
            return window;
        }
        const regex = /^(\d+)([smhd])$/;
        if (!regex.test(window)) {
            throw new Error(`Invalid window: ${window}`);
        }
        const [, valueStr, unit] = window.match(regex);
        const value = parseInt(valueStr);
        switch(unit){
            case "s":
                return value * 1e3;
            case "m":
                return value * 1e3 * 60;
            case "h":
                return value * 1e3 * 60 * 60;
            case "d":
                return value * 1e3 * 60 * 60 * 24;
            default:
                throw new Error(`Invalid window unit: ${unit}`);
        }
    }
    async ingest(table, ...events) {
        this.validateTableName(table);
        await Promise.all(events.map(async (event)=>{
            const time = event.time ?? Date.now();
            const bucket = Math.floor(time / this.bucketSize) * this.bucketSize;
            const key = [
                this.prefix,
                table,
                bucket
            ].join(":");
            await this.redis.hincrby(key, JSON.stringify({
                ...event,
                time: void 0
            }), 1);
        }));
    }
    async loadBuckets(table, opts) {
        this.validateTableName(table);
        const now = Date.now();
        const keys = [];
        if (opts.scan) {
            let cursor = 0;
            const match = [
                this.prefix,
                table,
                "*"
            ].join(":");
            do {
                const [nextCursor, found] = await this.redis.scan(cursor, {
                    match
                });
                cursor = nextCursor;
                for (const key of found){
                    const timestamp = parseInt(key.split(":").pop());
                    if (this.retention && timestamp < now - this.retention) {
                        await this.redis.del(key);
                        continue;
                    }
                    if (timestamp >= opts.range[0] || timestamp <= opts.range[1]) {
                        keys.push(key);
                    }
                }
            }while (cursor !== 0);
        } else {
            let t = Math.floor(now / this.bucketSize) * this.bucketSize;
            while(t > opts.range[1]){
                t -= this.bucketSize;
            }
            while(t >= opts.range[0]){
                keys.push([
                    this.prefix,
                    table,
                    t
                ].join(":"));
                t -= this.bucketSize;
            }
        }
        const loadKeys = [];
        const buckets = [];
        for (const key of keys){
            const cached = this.cache.get(key);
            if (cached) {
                buckets.push({
                    key,
                    hash: cached
                });
            } else {
                loadKeys.push(key);
            }
        }
        const p = this.redis.pipeline();
        for (const key of loadKeys){
            p.hgetall(key);
        }
        const res = loadKeys.length > 0 ? await p.exec() : [];
        for(let i = 0; i < loadKeys.length; i++){
            const key = loadKeys[i];
            const hash = res[i];
            if (hash) {
                this.cache.set(key, hash);
            }
            buckets.push({
                key,
                hash: hash ?? {}
            });
        }
        return buckets.sort((a, b)=>a.hash.time - b.hash.time);
    }
    async count(table, opts) {
        this.validateTableName(table);
        const buckets = await this.loadBuckets(table, {
            range: opts.range
        });
        return await Promise.all(buckets.map(async ({ key, hash })=>{
            const timestamp = parseInt(key.split(":").pop());
            return {
                time: timestamp,
                count: Object.values(hash).reduce((acc, curr)=>acc + curr, 0)
            };
        }));
    }
    async aggregateBy(table, aggregateBy, opts) {
        this.validateTableName(table);
        const buckets = await this.loadBuckets(table, {
            range: opts.range
        });
        const days = await Promise.all(buckets.map(async ({ key, hash })=>{
            const day = {
                time: Key.fromString(key).bucket
            };
            for (const [field, count] of Object.entries(hash)){
                const r = JSON.parse(field);
                for (const [k, v] of Object.entries(r)){
                    const agg = r[aggregateBy];
                    if (!day[agg]) {
                        day[agg] = {};
                    }
                    if (k === aggregateBy) {
                        continue;
                    }
                    if (!day[agg][v]) {
                        day[agg][v] = 0;
                    }
                    day[agg][v] += count;
                }
            }
            return day;
        }));
        return days;
    }
    async query(table, opts) {
        this.validateTableName(table);
        const buckets = await this.loadBuckets(table, {
            range: opts.range
        });
        const days = await Promise.all(buckets.map(async ({ key, hash })=>{
            const day = {
                time: Key.fromString(key).bucket
            };
            for (const [field, count] of Object.entries(hash)){
                const r = JSON.parse(field);
                let skip = false;
                if (opts?.where) {
                    for (const [requiredKey, requiredValue] of Object.entries(opts.where)){
                        if (!(requiredKey in r)) {
                            skip = true;
                            break;
                        }
                        if (r[requiredKey] !== requiredValue) {
                            skip = true;
                            break;
                        }
                    }
                }
                if (skip) {
                    continue;
                }
                for (const [k, v] of Object.entries(r)){
                    if (opts?.filter && !opts.filter.includes(k)) {
                        continue;
                    }
                    if (!day[k]) {
                        day[k] = {};
                    }
                    if (!day[k][v]) {
                        day[k][v] = 0;
                    }
                    day[k][v] += count;
                }
            }
            return day;
        }));
        return days;
    }
};
// Annotate the CommonJS export names for ESM import in node:
0 && (0); //# sourceMappingURL=index.js.map


/***/ }),

/***/ 7645:
/***/ ((module, __unused_webpack_exports, __webpack_require__) => {


var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all)=>{
    for(var name in all)__defProp(target, name, {
        get: all[name],
        enumerable: true
    });
};
var __copyProps = (to, from, except, desc)=>{
    if (from && typeof from === "object" || typeof from === "function") {
        for (let key of __getOwnPropNames(from))if (!__hasOwnProp.call(to, key) && key !== except) __defProp(to, key, {
            get: ()=>from[key],
            enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
        });
    }
    return to;
};
var __toCommonJS = (mod)=>__copyProps(__defProp({}, "__esModule", {
        value: true
    }), mod);
// src/index.ts
var src_exports = {};
__export(src_exports, {
    Analytics: ()=>Analytics,
    MultiRegionRatelimit: ()=>MultiRegionRatelimit,
    Ratelimit: ()=>RegionRatelimit
});
module.exports = __toCommonJS(src_exports);
// src/duration.ts
function ms(d) {
    const [timeString, duration] = d.split(" ");
    const time = parseFloat(timeString);
    switch(duration){
        case "ms":
            return time;
        case "s":
            return time * 1e3;
        case "m":
            return time * 1e3 * 60;
        case "h":
            return time * 1e3 * 60 * 60;
        case "d":
            return time * 1e3 * 60 * 60 * 24;
        default:
            throw new Error(`Unable to parse window size: ${d}`);
    }
}
// src/analytics.ts
var import_core_analytics = __webpack_require__(5797);
var Analytics = class {
    constructor(config){
        this.table = "events";
        this.analytics = new import_core_analytics.Analytics({
            redis: config.redis,
            window: "1h",
            prefix: config.prefix ?? "@upstash/ratelimit",
            retention: "90d"
        });
    }
    /**
   * Try to extract the geo information from the request
   *
   * This handles Vercel's `req.geo` and  and Cloudflare's `request.cf` properties
   * @param req
   * @returns
   */ extractGeo(req) {
        if (typeof req.geo !== "undefined") {
            return req.geo;
        }
        if (typeof req.cf !== "undefined") {
            return req.cf;
        }
        return {};
    }
    async record(event) {
        await this.analytics.ingest(this.table, event);
    }
    async series(filter, cutoff) {
        const records = await this.analytics.query(this.table, {
            filter: [
                filter
            ],
            range: [
                cutoff,
                Date.now()
            ]
        });
        return records;
    }
    async getUsage(cutoff = 0) {
        const records = await this.analytics.aggregateBy(this.table, "identifier", {
            range: [
                cutoff,
                Date.now()
            ]
        });
        const usage = {};
        for (const bucket of records){
            for (const [k, v] of Object.entries(bucket)){
                if (k === "time") {
                    continue;
                }
                if (!usage[k]) {
                    usage[k] = {
                        success: 0,
                        blocked: 0
                    };
                }
                usage[k].success += v["true"] ?? 0;
                usage[k].blocked += v["false"] ?? 0;
            }
        }
        return usage;
    }
};
// src/cache.ts
var Cache = class {
    constructor(cache){
        this.cache = cache;
    }
    isBlocked(identifier) {
        if (!this.cache.has(identifier)) {
            return {
                blocked: false,
                reset: 0
            };
        }
        const reset = this.cache.get(identifier);
        if (reset < Date.now()) {
            this.cache.delete(identifier);
            return {
                blocked: false,
                reset: 0
            };
        }
        return {
            blocked: true,
            reset
        };
    }
    blockUntil(identifier, reset) {
        this.cache.set(identifier, reset);
    }
    set(key, value) {
        this.cache.set(key, value);
    }
    get(key) {
        return this.cache.get(key) || null;
    }
    incr(key) {
        let value = this.cache.get(key) ?? 0;
        value += 1;
        this.cache.set(key, value);
        return value;
    }
};
// src/ratelimit.ts
var Ratelimit = class {
    constructor(config){
        /**
   * Determine if a request should pass or be rejected based on the identifier and previously chosen ratelimit.
   *
   * Use this if you want to reject all requests that you can not handle right now.
   *
   * @example
   * ```ts
   *  const ratelimit = new Ratelimit({
   *    redis: Redis.fromEnv(),
   *    limiter: Ratelimit.slidingWindow(10, "10 s")
   *  })
   *
   *  const { success } = await ratelimit.limit(id)
   *  if (!success){
   *    return "Nope"
   *  }
   *  return "Yes"
   * ```
   */ this.limit = async (identifier, req)=>{
            const key = [
                this.prefix,
                identifier
            ].join(":");
            let timeoutId = null;
            try {
                const arr = [
                    this.limiter(this.ctx, key)
                ];
                if (this.timeout > 0) {
                    arr.push(new Promise((resolve)=>{
                        timeoutId = setTimeout(()=>{
                            resolve({
                                success: true,
                                limit: 0,
                                remaining: 0,
                                reset: 0,
                                pending: Promise.resolve()
                            });
                        }, this.timeout);
                    }));
                }
                const res = await Promise.race(arr);
                if (this.analytics) {
                    try {
                        const geo = req ? this.analytics.extractGeo(req) : void 0;
                        const analyticsP = this.analytics.record({
                            identifier,
                            time: Date.now(),
                            success: res.success,
                            ...geo
                        }).catch((err)=>{
                            console.warn("Failed to record analytics", err);
                        });
                        res.pending = Promise.all([
                            res.pending,
                            analyticsP
                        ]);
                    } catch (err) {
                        console.warn("Failed to record analytics", err);
                    }
                }
                return res;
            } finally{
                if (timeoutId) {
                    clearTimeout(timeoutId);
                }
            }
        };
        /**
   * Block until the request may pass or timeout is reached.
   *
   * This method returns a promsie that resolves as soon as the request may be processed
   * or after the timeoue has been reached.
   *
   * Use this if you want to delay the request until it is ready to get processed.
   *
   * @example
   * ```ts
   *  const ratelimit = new Ratelimit({
   *    redis: Redis.fromEnv(),
   *    limiter: Ratelimit.slidingWindow(10, "10 s")
   *  })
   *
   *  const { success } = await ratelimit.blockUntilReady(id, 60_000)
   *  if (!success){
   *    return "Nope"
   *  }
   *  return "Yes"
   * ```
   */ this.blockUntilReady = async (identifier, timeout)=>{
            if (timeout <= 0) {
                throw new Error("timeout must be positive");
            }
            let res;
            const deadline = Date.now() + timeout;
            while(true){
                res = await this.limit(identifier);
                if (res.success) {
                    break;
                }
                if (res.reset === 0) {
                    throw new Error("This should not happen");
                }
                const wait = Math.min(res.reset, deadline) - Date.now();
                await new Promise((r)=>setTimeout(r, wait));
                if (Date.now() > deadline) {
                    break;
                }
            }
            return res;
        };
        this.ctx = config.ctx;
        this.limiter = config.limiter;
        this.timeout = config.timeout ?? 5e3;
        this.prefix = config.prefix ?? "@upstash/ratelimit";
        this.analytics = config.analytics !== false ? new Analytics({
            redis: Array.isArray(this.ctx.redis) ? this.ctx.redis[0] : this.ctx.redis,
            prefix: this.prefix
        }) : void 0;
        if (config.ephemeralCache instanceof Map) {
            this.ctx.cache = new Cache(config.ephemeralCache);
        } else if (typeof config.ephemeralCache === "undefined") {
            this.ctx.cache = new Cache(/* @__PURE__ */ new Map());
        }
    }
};
// src/single.ts
var RegionRatelimit = class extends Ratelimit {
    /**
   * Create a new Ratelimit instance by providing a `@upstash/redis` instance and the algorithn of your choice.
   */ constructor(config){
        super({
            prefix: config.prefix,
            limiter: config.limiter,
            timeout: config.timeout,
            analytics: config.analytics,
            ctx: {
                redis: config.redis
            },
            ephemeralCache: config.ephemeralCache
        });
    }
    /**
   * Each requests inside a fixed time increases a counter.
   * Once the counter reaches a maxmimum allowed number, all further requests are
   * rejected.
   *
   * **Pro:**
   *
   * - Newer requests are not starved by old ones.
   * - Low storage cost.
   *
   * **Con:**
   *
   * A burst of requests near the boundary of a window can result in a very
   * high request rate because two windows will be filled with requests quickly.
   *
   * @param tokens - How many requests a user can make in each time window.
   * @param window - A fixed timeframe
   */ static fixedWindow(tokens, window) {
        const windowDuration = ms(window);
        const script = `
    local key     = KEYS[1]
    local window  = ARGV[1]
    
    local r = redis.call("INCR", key)
    if r == 1 then 
    -- The first time this key is set, the value will be 1.
    -- So we only need the expire command once
    redis.call("PEXPIRE", key, window)
    end
    
    return r
    `;
        return async function(ctx, identifier) {
            const bucket = Math.floor(Date.now() / windowDuration);
            const key = [
                identifier,
                bucket
            ].join(":");
            if (ctx.cache) {
                const { blocked, reset: reset2 } = ctx.cache.isBlocked(identifier);
                if (blocked) {
                    return {
                        success: false,
                        limit: tokens,
                        remaining: 0,
                        reset: reset2,
                        pending: Promise.resolve()
                    };
                }
            }
            const usedTokensAfterUpdate = await ctx.redis.eval(script, [
                key
            ], [
                windowDuration
            ]);
            const success = usedTokensAfterUpdate <= tokens;
            const reset = (bucket + 1) * windowDuration;
            if (ctx.cache && !success) {
                ctx.cache.blockUntil(identifier, reset);
            }
            return {
                success,
                limit: tokens,
                remaining: tokens - usedTokensAfterUpdate,
                reset,
                pending: Promise.resolve()
            };
        };
    }
    /**
   * Combined approach of `slidingLogs` and `fixedWindow` with lower storage
   * costs than `slidingLogs` and improved boundary behavior by calcualting a
   * weighted score between two windows.
   *
   * **Pro:**
   *
   * Good performance allows this to scale to very high loads.
   *
   * **Con:**
   *
   * Nothing major.
   *
   * @param tokens - How many requests a user can make in each time window.
   * @param window - The duration in which the user can max X requests.
   */ static slidingWindow(tokens, window) {
        const script = `
      local currentKey  = KEYS[1]           -- identifier including prefixes
      local previousKey = KEYS[2]           -- key of the previous bucket
      local tokens      = tonumber(ARGV[1]) -- tokens per window
      local now         = ARGV[2]           -- current timestamp in milliseconds
      local window      = ARGV[3]           -- interval in milliseconds

      local requestsInCurrentWindow = redis.call("GET", currentKey)
      if requestsInCurrentWindow == false then
        requestsInCurrentWindow = 0
      end


      local requestsInPreviousWindow = redis.call("GET", previousKey)
      if requestsInPreviousWindow == false then
        requestsInPreviousWindow = 0
      end
      local percentageInCurrent = ( now % window) / window
      if requestsInPreviousWindow * ( 1 - percentageInCurrent ) + requestsInCurrentWindow >= tokens then
        return 0
      end

      local newValue = redis.call("INCR", currentKey)
      if newValue == 1 then 
        -- The first time this key is set, the value will be 1.
        -- So we only need the expire command once
        redis.call("PEXPIRE", currentKey, window * 2 + 1000) -- Enough time to overlap with a new window + 1 second
      end
      return tokens - newValue
      `;
        const windowSize = ms(window);
        return async function(ctx, identifier) {
            const now = Date.now();
            const currentWindow = Math.floor(now / windowSize);
            const currentKey = [
                identifier,
                currentWindow
            ].join(":");
            const previousWindow = currentWindow - windowSize;
            const previousKey = [
                identifier,
                previousWindow
            ].join(":");
            if (ctx.cache) {
                const { blocked, reset: reset2 } = ctx.cache.isBlocked(identifier);
                if (blocked) {
                    return {
                        success: false,
                        limit: tokens,
                        remaining: 0,
                        reset: reset2,
                        pending: Promise.resolve()
                    };
                }
            }
            const remaining = await ctx.redis.eval(script, [
                currentKey,
                previousKey
            ], [
                tokens,
                now,
                windowSize
            ]);
            const success = remaining > 0;
            const reset = (currentWindow + 1) * windowSize;
            if (ctx.cache && !success) {
                ctx.cache.blockUntil(identifier, reset);
            }
            return {
                success,
                limit: tokens,
                remaining,
                reset,
                pending: Promise.resolve()
            };
        };
    }
    /**
   * You have a bucket filled with `{maxTokens}` tokens that refills constantly
   * at `{refillRate}` per `{interval}`.
   * Every request will remove one token from the bucket and if there is no
   * token to take, the request is rejected.
   *
   * **Pro:**
   *
   * - Bursts of requests are smoothed out and you can process them at a constant
   * rate.
   * - Allows to set a higher initial burst limit by setting `maxTokens` higher
   * than `refillRate`
   */ static tokenBucket(refillRate, interval, maxTokens) {
        const script = `
        local key         = KEYS[1]           -- identifier including prefixes
        local maxTokens   = tonumber(ARGV[1]) -- maximum number of tokens
        local interval    = tonumber(ARGV[2]) -- size of the window in milliseconds
        local refillRate  = tonumber(ARGV[3]) -- how many tokens are refilled after each interval
        local now         = tonumber(ARGV[4]) -- current timestamp in milliseconds
        local remaining   = 0
        
        local bucket = redis.call("HMGET", key, "updatedAt", "tokens")
        
        if bucket[1] == false then
          -- The bucket does not exist yet, so we create it and add a ttl.
          remaining = maxTokens - 1
          
          redis.call("HMSET", key, "updatedAt", now, "tokens", remaining)
          redis.call("PEXPIRE", key, interval)
  
          return {remaining, now + interval}
        end

        -- The bucket does exist
  
        local updatedAt = tonumber(bucket[1])
        local tokens = tonumber(bucket[2])
  
        if now >= updatedAt + interval then
          remaining = math.min(maxTokens, tokens + refillRate) - 1
          
          redis.call("HMSET", key, "updatedAt", now, "tokens", remaining)
          return {remaining, now + interval}
        end
  
        if tokens > 0 then
          remaining = tokens - 1
          redis.call("HMSET", key, "updatedAt", now, "tokens", remaining)
        end
  
        return {remaining, updatedAt + interval}
       `;
        const intervalDuration = ms(interval);
        return async function(ctx, identifier) {
            if (ctx.cache) {
                const { blocked, reset: reset2 } = ctx.cache.isBlocked(identifier);
                if (blocked) {
                    return {
                        success: false,
                        limit: maxTokens,
                        remaining: 0,
                        reset: reset2,
                        pending: Promise.resolve()
                    };
                }
            }
            const now = Date.now();
            const key = [
                identifier,
                Math.floor(now / intervalDuration)
            ].join(":");
            const [remaining, reset] = await ctx.redis.eval(script, [
                key
            ], [
                maxTokens,
                intervalDuration,
                refillRate,
                now
            ]);
            const success = remaining > 0;
            if (ctx.cache && !success) {
                ctx.cache.blockUntil(identifier, reset);
            }
            return {
                success,
                limit: maxTokens,
                remaining,
                reset,
                pending: Promise.resolve()
            };
        };
    }
    /**
   * cachedFixedWindow first uses the local cache to decide if a request may pass and then updates
   * it asynchronously.
   * This is experimental and not yet recommended for production use.
   *
   * @experimental
   *
   * Each requests inside a fixed time increases a counter.
   * Once the counter reaches a maxmimum allowed number, all further requests are
   * rejected.
   *
   * **Pro:**
   *
   * - Newer requests are not starved by old ones.
   * - Low storage cost.
   *
   * **Con:**
   *
   * A burst of requests near the boundary of a window can result in a very
   * high request rate because two windows will be filled with requests quickly.
   *
   * @param tokens - How many requests a user can make in each time window.
   * @param window - A fixed timeframe
   */ static cachedFixedWindow(tokens, window) {
        const windowDuration = ms(window);
        const script = `
      local key     = KEYS[1]
      local window  = ARGV[1]
      
      local r = redis.call("INCR", key)
      if r == 1 then 
      -- The first time this key is set, the value will be 1.
      -- So we only need the expire command once
      redis.call("PEXPIRE", key, window)
      end
      
      return r
      `;
        return async function(ctx, identifier) {
            if (!ctx.cache) {
                throw new Error("This algorithm requires a cache");
            }
            const bucket = Math.floor(Date.now() / windowDuration);
            const key = [
                identifier,
                bucket
            ].join(":");
            const reset = (bucket + 1) * windowDuration;
            const hit = typeof ctx.cache.get(key) === "number";
            if (hit) {
                const cachedTokensAfterUpdate = ctx.cache.incr(key);
                const success = cachedTokensAfterUpdate < tokens;
                const pending = success ? ctx.redis.eval(script, [
                    key
                ], [
                    windowDuration
                ]).then((t)=>{
                    ctx.cache.set(key, t);
                }) : Promise.resolve();
                return {
                    success,
                    limit: tokens,
                    remaining: tokens - cachedTokensAfterUpdate,
                    reset,
                    pending
                };
            }
            const usedTokensAfterUpdate = await ctx.redis.eval(script, [
                key
            ], [
                windowDuration
            ]);
            ctx.cache.set(key, usedTokensAfterUpdate);
            const remaining = tokens - usedTokensAfterUpdate;
            return {
                success: remaining >= 0,
                limit: tokens,
                remaining,
                reset,
                pending: Promise.resolve()
            };
        };
    }
};
// src/multi.ts
function randomId() {
    let result = "";
    const characters = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    const charactersLength = characters.length;
    for(let i = 0; i < 16; i++){
        result += characters.charAt(Math.floor(Math.random() * charactersLength));
    }
    return result;
}
var MultiRegionRatelimit = class extends Ratelimit {
    /**
   * Create a new Ratelimit instance by providing a `@upstash/redis` instance and the algorithn of your choice.
   */ constructor(config){
        super({
            prefix: config.prefix,
            limiter: config.limiter,
            timeout: config.timeout,
            analytics: config.analytics,
            ctx: {
                redis: config.redis,
                cache: config.ephemeralCache ? new Cache(config.ephemeralCache) : void 0
            }
        });
    }
    /**
   * Each requests inside a fixed time increases a counter.
   * Once the counter reaches a maxmimum allowed number, all further requests are
   * rejected.
   *
   * **Pro:**
   *
   * - Newer requests are not starved by old ones.
   * - Low storage cost.
   *
   * **Con:**
   *
   * A burst of requests near the boundary of a window can result in a very
   * high request rate because two windows will be filled with requests quickly.
   *
   * @param tokens - How many requests a user can make in each time window.
   * @param window - A fixed timeframe
   */ static fixedWindow(tokens, window) {
        const windowDuration = ms(window);
        const script = `
    local key     = KEYS[1]
    local id      = ARGV[1]
    local window  = ARGV[2]
    
    redis.call("SADD", key, id)
    local members = redis.call("SMEMBERS", key)
    if #members == 1 then
    -- The first time this key is set, the value will be 1.
    -- So we only need the expire command once
      redis.call("PEXPIRE", key, window)
    end
    
    return members
`;
        return async function(ctx, identifier) {
            if (ctx.cache) {
                const { blocked, reset: reset2 } = ctx.cache.isBlocked(identifier);
                if (blocked) {
                    return {
                        success: false,
                        limit: tokens,
                        remaining: 0,
                        reset: reset2,
                        pending: Promise.resolve()
                    };
                }
            }
            const requestID = randomId();
            const bucket = Math.floor(Date.now() / windowDuration);
            const key = [
                identifier,
                bucket
            ].join(":");
            const dbs = ctx.redis.map((redis)=>({
                    redis,
                    request: redis.eval(script, [
                        key
                    ], [
                        requestID,
                        windowDuration
                    ])
                }));
            const firstResponse = await Promise.any(dbs.map((s)=>s.request));
            const usedTokens = firstResponse.length;
            const remaining = tokens - usedTokens - 1;
            async function sync() {
                const individualIDs = await Promise.all(dbs.map((s)=>s.request));
                const allIDs = Array.from(new Set(individualIDs.flatMap((_)=>_)).values());
                for (const db of dbs){
                    const ids = await db.request;
                    if (ids.length >= tokens) {
                        continue;
                    }
                    const diff = allIDs.filter((id)=>!ids.includes(id));
                    if (diff.length === 0) {
                        continue;
                    }
                    await db.redis.sadd(key, ...allIDs);
                }
            }
            const success = remaining > 0;
            const reset = (bucket + 1) * windowDuration;
            if (ctx.cache && !success) {
                ctx.cache.blockUntil(identifier, reset);
            }
            return {
                success,
                limit: tokens,
                remaining,
                reset,
                pending: sync()
            };
        };
    }
    /**
   * Combined approach of `slidingLogs` and `fixedWindow` with lower storage
   * costs than `slidingLogs` and improved boundary behavior by calcualting a
   * weighted score between two windows.
   *
   * **Pro:**
   *
   * Good performance allows this to scale to very high loads.
   *
   * **Con:**
   *
   * Nothing major.
   *
   * @param tokens - How many requests a user can make in each time window.
   * @param window - The duration in which the user can max X requests.
   */ static slidingWindow(tokens, window) {
        const windowSize = ms(window);
        const script = `
      local currentKey  = KEYS[1]           -- identifier including prefixes
      local previousKey = KEYS[2]           -- key of the previous bucket
      local tokens      = tonumber(ARGV[1]) -- tokens per window
      local now         = ARGV[2]           -- current timestamp in milliseconds
      local window      = ARGV[3]           -- interval in milliseconds
      local requestID   = ARGV[4]           -- uuid for this request


      local currentMembers = redis.call("SMEMBERS", currentKey)
      local requestsInCurrentWindow = #currentMembers
      local previousMembers = redis.call("SMEMBERS", previousKey)
      local requestsInPreviousWindow = #previousMembers

      local percentageInCurrent = ( now % window) / window
      if requestsInPreviousWindow * ( 1 - percentageInCurrent ) + requestsInCurrentWindow >= tokens then
        return {currentMembers, previousMembers}
      end

      redis.call("SADD", currentKey, requestID)
      table.insert(currentMembers, requestID)
      if requestsInCurrentWindow == 0 then 
        -- The first time this key is set, the value will be 1.
        -- So we only need the expire command once
        redis.call("PEXPIRE", currentKey, window * 2 + 1000) -- Enough time to overlap with a new window + 1 second
      end
      return {currentMembers, previousMembers}
      `;
        const windowDuration = ms(window);
        return async function(ctx, identifier) {
            if (ctx.cache) {
                const { blocked, reset: reset2 } = ctx.cache.isBlocked(identifier);
                if (blocked) {
                    return {
                        success: false,
                        limit: tokens,
                        remaining: 0,
                        reset: reset2,
                        pending: Promise.resolve()
                    };
                }
            }
            const requestID = randomId();
            const now = Date.now();
            const currentWindow = Math.floor(now / windowSize);
            const currentKey = [
                identifier,
                currentWindow
            ].join(":");
            const previousWindow = currentWindow - windowSize;
            const previousKey = [
                identifier,
                previousWindow
            ].join(":");
            const dbs = ctx.redis.map((redis)=>({
                    redis,
                    request: redis.eval(script, [
                        currentKey,
                        previousKey
                    ], [
                        tokens,
                        now,
                        windowDuration,
                        requestID
                    ])
                }));
            const percentageInCurrent = now % windowDuration / windowDuration;
            const [current, previous] = await Promise.any(dbs.map((s)=>s.request));
            const usedTokens = previous.length * (1 - percentageInCurrent) + current.length;
            const remaining = tokens - usedTokens;
            async function sync() {
                const [individualIDs] = await Promise.all(dbs.map((s)=>s.request));
                const allIDs = Array.from(new Set(individualIDs.flatMap((_)=>_)).values());
                for (const db of dbs){
                    const [ids] = await db.request;
                    if (ids.length >= tokens) {
                        continue;
                    }
                    const diff = allIDs.filter((id)=>!ids.includes(id));
                    if (diff.length === 0) {
                        continue;
                    }
                    await db.redis.sadd(currentKey, ...allIDs);
                }
            }
            const success = remaining > 0;
            const reset = (currentWindow + 1) * windowDuration;
            if (ctx.cache && !success) {
                ctx.cache.blockUntil(identifier, reset);
            }
            return {
                success,
                limit: tokens,
                remaining,
                reset,
                pending: sync()
            };
        };
    }
};
// Annotate the CommonJS export names for ESM import in node:
0 && (0); //# sourceMappingURL=index.js.map


/***/ }),

/***/ 2093:
/***/ ((__unused_webpack_module, exports, __webpack_require__) => {


Object.defineProperty(exports, "__esModule", ({
    value: true
}));
0 && (0);
function _export(target, all) {
    for(var name in all)Object.defineProperty(target, name, {
        enumerable: true,
        get: all[name]
    });
}
_export(exports, {
    prefixes: function() {
        return prefixes;
    },
    wait: function() {
        return wait;
    },
    error: function() {
        return error;
    },
    warn: function() {
        return warn;
    },
    ready: function() {
        return ready;
    },
    info: function() {
        return info;
    },
    event: function() {
        return event;
    },
    trace: function() {
        return trace;
    },
    warnOnce: function() {
        return warnOnce;
    }
});
const _chalk = /*#__PURE__*/ _interop_require_default(__webpack_require__(2170));
function _interop_require_default(obj) {
    return obj && obj.__esModule ? obj : {
        default: obj
    };
}
const prefixes = {
    wait: "- " + _chalk.default.cyan("wait"),
    error: "- " + _chalk.default.red("error"),
    warn: "- " + _chalk.default.yellow("warn"),
    ready: "- " + _chalk.default.green("ready"),
    info: "- " + _chalk.default.cyan("info"),
    event: "- " + _chalk.default.magenta("event"),
    trace: "- " + _chalk.default.magenta("trace")
};
function wait(...message) {
    console.log(prefixes.wait, ...message);
}
function error(...message) {
    console.error(prefixes.error, ...message);
}
function warn(...message) {
    console.warn(prefixes.warn, ...message);
}
function ready(...message) {
    console.log(prefixes.ready, ...message);
}
function info(...message) {
    console.log(prefixes.info, ...message);
}
function event(...message) {
    console.log(prefixes.event, ...message);
}
function trace(...message) {
    console.log(prefixes.trace, ...message);
}
const warnOnceMessages = new Set();
function warnOnce(...message) {
    if (!warnOnceMessages.has(message[0])) {
        warnOnceMessages.add(message.join(" "));
        warn(...message);
    }
} //# sourceMappingURL=log.js.map


/***/ }),

/***/ 2827:
/***/ ((module, exports) => {


Object.defineProperty(exports, "__esModule", ({
    value: true
}));
0 && (0);
function _export(target, all) {
    for(var name in all)Object.defineProperty(target, name, {
        enumerable: true,
        get: all[name]
    });
}
_export(exports, {
    RSC: function() {
        return RSC;
    },
    ACTION: function() {
        return ACTION;
    },
    NEXT_ROUTER_STATE_TREE: function() {
        return NEXT_ROUTER_STATE_TREE;
    },
    NEXT_ROUTER_PREFETCH: function() {
        return NEXT_ROUTER_PREFETCH;
    },
    NEXT_URL: function() {
        return NEXT_URL;
    },
    FETCH_CACHE_HEADER: function() {
        return FETCH_CACHE_HEADER;
    },
    RSC_CONTENT_TYPE_HEADER: function() {
        return RSC_CONTENT_TYPE_HEADER;
    },
    RSC_VARY_HEADER: function() {
        return RSC_VARY_HEADER;
    },
    FLIGHT_PARAMETERS: function() {
        return FLIGHT_PARAMETERS;
    },
    NEXT_RSC_UNION_QUERY: function() {
        return NEXT_RSC_UNION_QUERY;
    }
});
const RSC = "RSC";
const ACTION = "Next-Action";
const NEXT_ROUTER_STATE_TREE = "Next-Router-State-Tree";
const NEXT_ROUTER_PREFETCH = "Next-Router-Prefetch";
const NEXT_URL = "Next-Url";
const FETCH_CACHE_HEADER = "x-vercel-sc-headers";
const RSC_CONTENT_TYPE_HEADER = "text/x-component";
const RSC_VARY_HEADER = RSC + ", " + NEXT_ROUTER_STATE_TREE + ", " + NEXT_ROUTER_PREFETCH;
const FLIGHT_PARAMETERS = [
    [
        RSC
    ],
    [
        NEXT_ROUTER_STATE_TREE
    ],
    [
        NEXT_ROUTER_PREFETCH
    ]
];
const NEXT_RSC_UNION_QUERY = "_rsc";
if ((typeof exports.default === "function" || typeof exports.default === "object" && exports.default !== null) && typeof exports.default.__esModule === "undefined") {
    Object.defineProperty(exports.default, "__esModule", {
        value: true
    });
    Object.assign(exports.default, exports);
    module.exports = exports.default;
} //# sourceMappingURL=app-router-headers.js.map


/***/ }),

/***/ 4390:
/***/ ((module, exports, __webpack_require__) => {


Object.defineProperty(exports, "__esModule", ({
    value: true
}));
Object.defineProperty(exports, "DraftMode", ({
    enumerable: true,
    get: function() {
        return DraftMode;
    }
}));
const _staticgenerationbailout = __webpack_require__(6675);
class DraftMode {
    get isEnabled() {
        return this._provider.isEnabled;
    }
    enable() {
        if ((0, _staticgenerationbailout.staticGenerationBailout)("draftMode().enable()")) {
            return;
        }
        return this._provider.enable();
    }
    disable() {
        if ((0, _staticgenerationbailout.staticGenerationBailout)("draftMode().disable()")) {
            return;
        }
        return this._provider.disable();
    }
    constructor(provider){
        this._provider = provider;
    }
}
if ((typeof exports.default === "function" || typeof exports.default === "object" && exports.default !== null) && typeof exports.default.__esModule === "undefined") {
    Object.defineProperty(exports.default, "__esModule", {
        value: true
    });
    Object.assign(exports.default, exports);
    module.exports = exports.default;
} //# sourceMappingURL=draft-mode.js.map


/***/ }),

/***/ 5117:
/***/ ((module, exports, __webpack_require__) => {


Object.defineProperty(exports, "__esModule", ({
    value: true
}));
0 && (0);
function _export(target, all) {
    for(var name in all)Object.defineProperty(target, name, {
        enumerable: true,
        get: all[name]
    });
}
_export(exports, {
    headers: function() {
        return headers;
    },
    cookies: function() {
        return cookies;
    },
    draftMode: function() {
        return draftMode;
    }
});
const _requestcookies = __webpack_require__(4895);
const _headers = __webpack_require__(6877);
const _cookies = __webpack_require__(6454);
const _requestasyncstorage = __webpack_require__(5344);
const _actionasyncstorage = __webpack_require__(8277);
const _staticgenerationbailout = __webpack_require__(6675);
const _draftmode = __webpack_require__(4390);
function headers() {
    if ((0, _staticgenerationbailout.staticGenerationBailout)("headers")) {
        return _headers.HeadersAdapter.seal(new Headers({}));
    }
    const requestStore = _requestasyncstorage.requestAsyncStorage.getStore();
    if (!requestStore) {
        throw new Error("Invariant: Method expects to have requestAsyncStorage, none available");
    }
    return requestStore.headers;
}
function cookies() {
    if ((0, _staticgenerationbailout.staticGenerationBailout)("cookies")) {
        return _requestcookies.RequestCookiesAdapter.seal(new _cookies.RequestCookies(new Headers({})));
    }
    const requestStore = _requestasyncstorage.requestAsyncStorage.getStore();
    if (!requestStore) {
        throw new Error("Invariant: Method expects to have requestAsyncStorage, none available");
    }
    const asyncActionStore = _actionasyncstorage.actionAsyncStorage.getStore();
    if (asyncActionStore && (asyncActionStore.isAction || asyncActionStore.isAppRoute)) {
        // We can't conditionally return different types here based on the context.
        // To avoid confusion, we always return the readonly type here.
        return requestStore.mutableCookies;
    }
    return requestStore.cookies;
}
function draftMode() {
    const requestStore = _requestasyncstorage.requestAsyncStorage.getStore();
    if (!requestStore) {
        throw new Error("Invariant: Method expects to have requestAsyncStorage, none available");
    }
    return new _draftmode.DraftMode(requestStore.draftMode);
}
if ((typeof exports.default === "function" || typeof exports.default === "object" && exports.default !== null) && typeof exports.default.__esModule === "undefined") {
    Object.defineProperty(exports.default, "__esModule", {
        value: true
    });
    Object.assign(exports.default, exports);
    module.exports = exports.default;
} //# sourceMappingURL=headers.js.map


/***/ }),

/***/ 6966:
/***/ ((module, exports) => {


Object.defineProperty(exports, "__esModule", ({
    value: true
}));
0 && (0);
function _export(target, all) {
    for(var name in all)Object.defineProperty(target, name, {
        enumerable: true,
        get: all[name]
    });
}
_export(exports, {
    notFound: function() {
        return notFound;
    },
    isNotFoundError: function() {
        return isNotFoundError;
    }
});
const NOT_FOUND_ERROR_CODE = "NEXT_NOT_FOUND";
function notFound() {
    // eslint-disable-next-line no-throw-literal
    const error = new Error(NOT_FOUND_ERROR_CODE);
    error.digest = NOT_FOUND_ERROR_CODE;
    throw error;
}
function isNotFoundError(error) {
    return (error == null ? void 0 : error.digest) === NOT_FOUND_ERROR_CODE;
}
if ((typeof exports.default === "function" || typeof exports.default === "object" && exports.default !== null) && typeof exports.default.__esModule === "undefined") {
    Object.defineProperty(exports.default, "__esModule", {
        value: true
    });
    Object.assign(exports.default, exports);
    module.exports = exports.default;
} //# sourceMappingURL=not-found.js.map


/***/ }),

/***/ 8043:
/***/ ((module, exports, __webpack_require__) => {


Object.defineProperty(exports, "__esModule", ({
    value: true
}));
0 && (0);
function _export(target, all) {
    for(var name in all)Object.defineProperty(target, name, {
        enumerable: true,
        get: all[name]
    });
}
_export(exports, {
    RedirectType: function() {
        return RedirectType;
    },
    getRedirectError: function() {
        return getRedirectError;
    },
    redirect: function() {
        return redirect;
    },
    isRedirectError: function() {
        return isRedirectError;
    },
    getURLFromRedirectError: function() {
        return getURLFromRedirectError;
    },
    getRedirectTypeFromError: function() {
        return getRedirectTypeFromError;
    }
});
const _requestasyncstorage = __webpack_require__(5344);
const REDIRECT_ERROR_CODE = "NEXT_REDIRECT";
var RedirectType;
(function(RedirectType) {
    RedirectType["push"] = "push";
    RedirectType["replace"] = "replace";
})(RedirectType || (RedirectType = {}));
function getRedirectError(url, type) {
    const error = new Error(REDIRECT_ERROR_CODE);
    error.digest = REDIRECT_ERROR_CODE + ";" + type + ";" + url;
    const requestStore = _requestasyncstorage.requestAsyncStorage.getStore();
    if (requestStore) {
        error.mutableCookies = requestStore.mutableCookies;
    }
    return error;
}
function redirect(url, type) {
    if (type === void 0) type = "replace";
    throw getRedirectError(url, type);
}
function isRedirectError(error) {
    if (typeof (error == null ? void 0 : error.digest) !== "string") return false;
    const [errorCode, type, destination] = error.digest.split(";", 3);
    return errorCode === REDIRECT_ERROR_CODE && (type === "replace" || type === "push") && typeof destination === "string";
}
function getURLFromRedirectError(error) {
    if (!isRedirectError(error)) return null;
    // Slices off the beginning of the digest that contains the code and the
    // separating ';'.
    return error.digest.split(";", 3)[2];
}
function getRedirectTypeFromError(error) {
    if (!isRedirectError(error)) {
        throw new Error("Not a redirect error");
    }
    return error.digest.split(";", 3)[1];
}
if ((typeof exports.default === "function" || typeof exports.default === "object" && exports.default !== null) && typeof exports.default.__esModule === "undefined") {
    Object.defineProperty(exports.default, "__esModule", {
        value: true
    });
    Object.assign(exports.default, exports);
    module.exports = exports.default;
} //# sourceMappingURL=redirect.js.map


/***/ }),

/***/ 7811:
/***/ ((module) => {


(()=>{
    "use strict";
    var e = {
        339: (e, t, r)=>{
            Object.defineProperty(t, "__esModule", {
                value: true
            });
            t.ContextAPI = void 0;
            const n = r(44);
            const a = r(38);
            const o = r(741);
            const i = "context";
            const c = new n.NoopContextManager;
            class ContextAPI {
                constructor(){}
                static getInstance() {
                    if (!this._instance) {
                        this._instance = new ContextAPI;
                    }
                    return this._instance;
                }
                setGlobalContextManager(e) {
                    return (0, a.registerGlobal)(i, e, o.DiagAPI.instance());
                }
                active() {
                    return this._getContextManager().active();
                }
                with(e, t, r, ...n) {
                    return this._getContextManager().with(e, t, r, ...n);
                }
                bind(e, t) {
                    return this._getContextManager().bind(e, t);
                }
                _getContextManager() {
                    return (0, a.getGlobal)(i) || c;
                }
                disable() {
                    this._getContextManager().disable();
                    (0, a.unregisterGlobal)(i, o.DiagAPI.instance());
                }
            }
            t.ContextAPI = ContextAPI;
        },
        741: (e, t, r)=>{
            Object.defineProperty(t, "__esModule", {
                value: true
            });
            t.DiagAPI = void 0;
            const n = r(144);
            const a = r(871);
            const o = r(133);
            const i = r(38);
            const c = "diag";
            class DiagAPI {
                constructor(){
                    function _logProxy(e) {
                        return function(...t) {
                            const r = (0, i.getGlobal)("diag");
                            if (!r) return;
                            return r[e](...t);
                        };
                    }
                    const e = this;
                    const setLogger = (t, r = {
                        logLevel: o.DiagLogLevel.INFO
                    })=>{
                        var n, c, s;
                        if (t === e) {
                            const t = new Error("Cannot use diag as the logger for itself. Please use a DiagLogger implementation like ConsoleDiagLogger or a custom implementation");
                            e.error((n = t.stack) !== null && n !== void 0 ? n : t.message);
                            return false;
                        }
                        if (typeof r === "number") {
                            r = {
                                logLevel: r
                            };
                        }
                        const u = (0, i.getGlobal)("diag");
                        const l = (0, a.createLogLevelDiagLogger)((c = r.logLevel) !== null && c !== void 0 ? c : o.DiagLogLevel.INFO, t);
                        if (u && !r.suppressOverrideMessage) {
                            const e = (s = (new Error).stack) !== null && s !== void 0 ? s : "<failed to generate stacktrace>";
                            u.warn(`Current logger will be overwritten from ${e}`);
                            l.warn(`Current logger will overwrite one already registered from ${e}`);
                        }
                        return (0, i.registerGlobal)("diag", l, e, true);
                    };
                    e.setLogger = setLogger;
                    e.disable = ()=>{
                        (0, i.unregisterGlobal)(c, e);
                    };
                    e.createComponentLogger = (e)=>new n.DiagComponentLogger(e);
                    e.verbose = _logProxy("verbose");
                    e.debug = _logProxy("debug");
                    e.info = _logProxy("info");
                    e.warn = _logProxy("warn");
                    e.error = _logProxy("error");
                }
                static instance() {
                    if (!this._instance) {
                        this._instance = new DiagAPI;
                    }
                    return this._instance;
                }
            }
            t.DiagAPI = DiagAPI;
        },
        128: (e, t, r)=>{
            Object.defineProperty(t, "__esModule", {
                value: true
            });
            t.MetricsAPI = void 0;
            const n = r(333);
            const a = r(38);
            const o = r(741);
            const i = "metrics";
            class MetricsAPI {
                constructor(){}
                static getInstance() {
                    if (!this._instance) {
                        this._instance = new MetricsAPI;
                    }
                    return this._instance;
                }
                setGlobalMeterProvider(e) {
                    return (0, a.registerGlobal)(i, e, o.DiagAPI.instance());
                }
                getMeterProvider() {
                    return (0, a.getGlobal)(i) || n.NOOP_METER_PROVIDER;
                }
                getMeter(e, t, r) {
                    return this.getMeterProvider().getMeter(e, t, r);
                }
                disable() {
                    (0, a.unregisterGlobal)(i, o.DiagAPI.instance());
                }
            }
            t.MetricsAPI = MetricsAPI;
        },
        930: (e, t, r)=>{
            Object.defineProperty(t, "__esModule", {
                value: true
            });
            t.PropagationAPI = void 0;
            const n = r(38);
            const a = r(600);
            const o = r(625);
            const i = r(377);
            const c = r(701);
            const s = r(741);
            const u = "propagation";
            const l = new a.NoopTextMapPropagator;
            class PropagationAPI {
                constructor(){
                    this.createBaggage = c.createBaggage;
                    this.getBaggage = i.getBaggage;
                    this.getActiveBaggage = i.getActiveBaggage;
                    this.setBaggage = i.setBaggage;
                    this.deleteBaggage = i.deleteBaggage;
                }
                static getInstance() {
                    if (!this._instance) {
                        this._instance = new PropagationAPI;
                    }
                    return this._instance;
                }
                setGlobalPropagator(e) {
                    return (0, n.registerGlobal)(u, e, s.DiagAPI.instance());
                }
                inject(e, t, r = o.defaultTextMapSetter) {
                    return this._getGlobalPropagator().inject(e, t, r);
                }
                extract(e, t, r = o.defaultTextMapGetter) {
                    return this._getGlobalPropagator().extract(e, t, r);
                }
                fields() {
                    return this._getGlobalPropagator().fields();
                }
                disable() {
                    (0, n.unregisterGlobal)(u, s.DiagAPI.instance());
                }
                _getGlobalPropagator() {
                    return (0, n.getGlobal)(u) || l;
                }
            }
            t.PropagationAPI = PropagationAPI;
        },
        967: (e, t, r)=>{
            Object.defineProperty(t, "__esModule", {
                value: true
            });
            t.TraceAPI = void 0;
            const n = r(38);
            const a = r(414);
            const o = r(994);
            const i = r(542);
            const c = r(741);
            const s = "trace";
            class TraceAPI {
                constructor(){
                    this._proxyTracerProvider = new a.ProxyTracerProvider;
                    this.wrapSpanContext = o.wrapSpanContext;
                    this.isSpanContextValid = o.isSpanContextValid;
                    this.deleteSpan = i.deleteSpan;
                    this.getSpan = i.getSpan;
                    this.getActiveSpan = i.getActiveSpan;
                    this.getSpanContext = i.getSpanContext;
                    this.setSpan = i.setSpan;
                    this.setSpanContext = i.setSpanContext;
                }
                static getInstance() {
                    if (!this._instance) {
                        this._instance = new TraceAPI;
                    }
                    return this._instance;
                }
                setGlobalTracerProvider(e) {
                    const t = (0, n.registerGlobal)(s, this._proxyTracerProvider, c.DiagAPI.instance());
                    if (t) {
                        this._proxyTracerProvider.setDelegate(e);
                    }
                    return t;
                }
                getTracerProvider() {
                    return (0, n.getGlobal)(s) || this._proxyTracerProvider;
                }
                getTracer(e, t) {
                    return this.getTracerProvider().getTracer(e, t);
                }
                disable() {
                    (0, n.unregisterGlobal)(s, c.DiagAPI.instance());
                    this._proxyTracerProvider = new a.ProxyTracerProvider;
                }
            }
            t.TraceAPI = TraceAPI;
        },
        377: (e, t, r)=>{
            Object.defineProperty(t, "__esModule", {
                value: true
            });
            t.deleteBaggage = t.setBaggage = t.getActiveBaggage = t.getBaggage = void 0;
            const n = r(339);
            const a = r(421);
            const o = (0, a.createContextKey)("OpenTelemetry Baggage Key");
            function getBaggage(e) {
                return e.getValue(o) || undefined;
            }
            t.getBaggage = getBaggage;
            function getActiveBaggage() {
                return getBaggage(n.ContextAPI.getInstance().active());
            }
            t.getActiveBaggage = getActiveBaggage;
            function setBaggage(e, t) {
                return e.setValue(o, t);
            }
            t.setBaggage = setBaggage;
            function deleteBaggage(e) {
                return e.deleteValue(o);
            }
            t.deleteBaggage = deleteBaggage;
        },
        496: (e, t)=>{
            Object.defineProperty(t, "__esModule", {
                value: true
            });
            t.BaggageImpl = void 0;
            class BaggageImpl {
                constructor(e){
                    this._entries = e ? new Map(e) : new Map;
                }
                getEntry(e) {
                    const t = this._entries.get(e);
                    if (!t) {
                        return undefined;
                    }
                    return Object.assign({}, t);
                }
                getAllEntries() {
                    return Array.from(this._entries.entries()).map(([e, t])=>[
                            e,
                            t
                        ]);
                }
                setEntry(e, t) {
                    const r = new BaggageImpl(this._entries);
                    r._entries.set(e, t);
                    return r;
                }
                removeEntry(e) {
                    const t = new BaggageImpl(this._entries);
                    t._entries.delete(e);
                    return t;
                }
                removeEntries(...e) {
                    const t = new BaggageImpl(this._entries);
                    for (const r of e){
                        t._entries.delete(r);
                    }
                    return t;
                }
                clear() {
                    return new BaggageImpl;
                }
            }
            t.BaggageImpl = BaggageImpl;
        },
        817: (e, t)=>{
            Object.defineProperty(t, "__esModule", {
                value: true
            });
            t.baggageEntryMetadataSymbol = void 0;
            t.baggageEntryMetadataSymbol = Symbol("BaggageEntryMetadata");
        },
        701: (e, t, r)=>{
            Object.defineProperty(t, "__esModule", {
                value: true
            });
            t.baggageEntryMetadataFromString = t.createBaggage = void 0;
            const n = r(741);
            const a = r(496);
            const o = r(817);
            const i = n.DiagAPI.instance();
            function createBaggage(e = {}) {
                return new a.BaggageImpl(new Map(Object.entries(e)));
            }
            t.createBaggage = createBaggage;
            function baggageEntryMetadataFromString(e) {
                if (typeof e !== "string") {
                    i.error(`Cannot create baggage metadata from unknown type: ${typeof e}`);
                    e = "";
                }
                return {
                    __TYPE__: o.baggageEntryMetadataSymbol,
                    toString () {
                        return e;
                    }
                };
            }
            t.baggageEntryMetadataFromString = baggageEntryMetadataFromString;
        },
        388: (e, t, r)=>{
            Object.defineProperty(t, "__esModule", {
                value: true
            });
            t.context = void 0;
            const n = r(339);
            t.context = n.ContextAPI.getInstance();
        },
        44: (e, t, r)=>{
            Object.defineProperty(t, "__esModule", {
                value: true
            });
            t.NoopContextManager = void 0;
            const n = r(421);
            class NoopContextManager {
                active() {
                    return n.ROOT_CONTEXT;
                }
                with(e, t, r, ...n) {
                    return t.call(r, ...n);
                }
                bind(e, t) {
                    return t;
                }
                enable() {
                    return this;
                }
                disable() {
                    return this;
                }
            }
            t.NoopContextManager = NoopContextManager;
        },
        421: (e, t)=>{
            Object.defineProperty(t, "__esModule", {
                value: true
            });
            t.ROOT_CONTEXT = t.createContextKey = void 0;
            function createContextKey(e) {
                return Symbol.for(e);
            }
            t.createContextKey = createContextKey;
            class BaseContext {
                constructor(e){
                    const t = this;
                    t._currentContext = e ? new Map(e) : new Map;
                    t.getValue = (e)=>t._currentContext.get(e);
                    t.setValue = (e, r)=>{
                        const n = new BaseContext(t._currentContext);
                        n._currentContext.set(e, r);
                        return n;
                    };
                    t.deleteValue = (e)=>{
                        const r = new BaseContext(t._currentContext);
                        r._currentContext.delete(e);
                        return r;
                    };
                }
            }
            t.ROOT_CONTEXT = new BaseContext;
        },
        920: (e, t, r)=>{
            Object.defineProperty(t, "__esModule", {
                value: true
            });
            t.diag = void 0;
            const n = r(741);
            t.diag = n.DiagAPI.instance();
        },
        144: (e, t, r)=>{
            Object.defineProperty(t, "__esModule", {
                value: true
            });
            t.DiagComponentLogger = void 0;
            const n = r(38);
            class DiagComponentLogger {
                constructor(e){
                    this._namespace = e.namespace || "DiagComponentLogger";
                }
                debug(...e) {
                    return logProxy("debug", this._namespace, e);
                }
                error(...e) {
                    return logProxy("error", this._namespace, e);
                }
                info(...e) {
                    return logProxy("info", this._namespace, e);
                }
                warn(...e) {
                    return logProxy("warn", this._namespace, e);
                }
                verbose(...e) {
                    return logProxy("verbose", this._namespace, e);
                }
            }
            t.DiagComponentLogger = DiagComponentLogger;
            function logProxy(e, t, r) {
                const a = (0, n.getGlobal)("diag");
                if (!a) {
                    return;
                }
                r.unshift(t);
                return a[e](...r);
            }
        },
        689: (e, t)=>{
            Object.defineProperty(t, "__esModule", {
                value: true
            });
            t.DiagConsoleLogger = void 0;
            const r = [
                {
                    n: "error",
                    c: "error"
                },
                {
                    n: "warn",
                    c: "warn"
                },
                {
                    n: "info",
                    c: "info"
                },
                {
                    n: "debug",
                    c: "debug"
                },
                {
                    n: "verbose",
                    c: "trace"
                }
            ];
            class DiagConsoleLogger {
                constructor(){
                    function _consoleFunc(e) {
                        return function(...t) {
                            if (console) {
                                let r = console[e];
                                if (typeof r !== "function") {
                                    r = console.log;
                                }
                                if (typeof r === "function") {
                                    return r.apply(console, t);
                                }
                            }
                        };
                    }
                    for(let e = 0; e < r.length; e++){
                        this[r[e].n] = _consoleFunc(r[e].c);
                    }
                }
            }
            t.DiagConsoleLogger = DiagConsoleLogger;
        },
        871: (e, t, r)=>{
            Object.defineProperty(t, "__esModule", {
                value: true
            });
            t.createLogLevelDiagLogger = void 0;
            const n = r(133);
            function createLogLevelDiagLogger(e, t) {
                if (e < n.DiagLogLevel.NONE) {
                    e = n.DiagLogLevel.NONE;
                } else if (e > n.DiagLogLevel.ALL) {
                    e = n.DiagLogLevel.ALL;
                }
                t = t || {};
                function _filterFunc(r, n) {
                    const a = t[r];
                    if (typeof a === "function" && e >= n) {
                        return a.bind(t);
                    }
                    return function() {};
                }
                return {
                    error: _filterFunc("error", n.DiagLogLevel.ERROR),
                    warn: _filterFunc("warn", n.DiagLogLevel.WARN),
                    info: _filterFunc("info", n.DiagLogLevel.INFO),
                    debug: _filterFunc("debug", n.DiagLogLevel.DEBUG),
                    verbose: _filterFunc("verbose", n.DiagLogLevel.VERBOSE)
                };
            }
            t.createLogLevelDiagLogger = createLogLevelDiagLogger;
        },
        133: (e, t)=>{
            Object.defineProperty(t, "__esModule", {
                value: true
            });
            t.DiagLogLevel = void 0;
            var r;
            (function(e) {
                e[e["NONE"] = 0] = "NONE";
                e[e["ERROR"] = 30] = "ERROR";
                e[e["WARN"] = 50] = "WARN";
                e[e["INFO"] = 60] = "INFO";
                e[e["DEBUG"] = 70] = "DEBUG";
                e[e["VERBOSE"] = 80] = "VERBOSE";
                e[e["ALL"] = 9999] = "ALL";
            })(r = t.DiagLogLevel || (t.DiagLogLevel = {}));
        },
        38: (e, t, r)=>{
            Object.defineProperty(t, "__esModule", {
                value: true
            });
            t.unregisterGlobal = t.getGlobal = t.registerGlobal = void 0;
            const n = r(966);
            const a = r(520);
            const o = r(565);
            const i = a.VERSION.split(".")[0];
            const c = Symbol.for(`opentelemetry.js.api.${i}`);
            const s = n._globalThis;
            function registerGlobal(e, t, r, n = false) {
                var o;
                const i = s[c] = (o = s[c]) !== null && o !== void 0 ? o : {
                    version: a.VERSION
                };
                if (!n && i[e]) {
                    const t = new Error(`@opentelemetry/api: Attempted duplicate registration of API: ${e}`);
                    r.error(t.stack || t.message);
                    return false;
                }
                if (i.version !== a.VERSION) {
                    const t = new Error(`@opentelemetry/api: Registration of version v${i.version} for ${e} does not match previously registered API v${a.VERSION}`);
                    r.error(t.stack || t.message);
                    return false;
                }
                i[e] = t;
                r.debug(`@opentelemetry/api: Registered a global for ${e} v${a.VERSION}.`);
                return true;
            }
            t.registerGlobal = registerGlobal;
            function getGlobal(e) {
                var t, r;
                const n = (t = s[c]) === null || t === void 0 ? void 0 : t.version;
                if (!n || !(0, o.isCompatible)(n)) {
                    return;
                }
                return (r = s[c]) === null || r === void 0 ? void 0 : r[e];
            }
            t.getGlobal = getGlobal;
            function unregisterGlobal(e, t) {
                t.debug(`@opentelemetry/api: Unregistering a global for ${e} v${a.VERSION}.`);
                const r = s[c];
                if (r) {
                    delete r[e];
                }
            }
            t.unregisterGlobal = unregisterGlobal;
        },
        565: (e, t, r)=>{
            Object.defineProperty(t, "__esModule", {
                value: true
            });
            t.isCompatible = t._makeCompatibilityCheck = void 0;
            const n = r(520);
            const a = /^(\d+)\.(\d+)\.(\d+)(-(.+))?$/;
            function _makeCompatibilityCheck(e) {
                const t = new Set([
                    e
                ]);
                const r = new Set;
                const n = e.match(a);
                if (!n) {
                    return ()=>false;
                }
                const o = {
                    major: +n[1],
                    minor: +n[2],
                    patch: +n[3],
                    prerelease: n[4]
                };
                if (o.prerelease != null) {
                    return function isExactmatch(t) {
                        return t === e;
                    };
                }
                function _reject(e) {
                    r.add(e);
                    return false;
                }
                function _accept(e) {
                    t.add(e);
                    return true;
                }
                return function isCompatible(e) {
                    if (t.has(e)) {
                        return true;
                    }
                    if (r.has(e)) {
                        return false;
                    }
                    const n = e.match(a);
                    if (!n) {
                        return _reject(e);
                    }
                    const i = {
                        major: +n[1],
                        minor: +n[2],
                        patch: +n[3],
                        prerelease: n[4]
                    };
                    if (i.prerelease != null) {
                        return _reject(e);
                    }
                    if (o.major !== i.major) {
                        return _reject(e);
                    }
                    if (o.major === 0) {
                        if (o.minor === i.minor && o.patch <= i.patch) {
                            return _accept(e);
                        }
                        return _reject(e);
                    }
                    if (o.minor <= i.minor) {
                        return _accept(e);
                    }
                    return _reject(e);
                };
            }
            t._makeCompatibilityCheck = _makeCompatibilityCheck;
            t.isCompatible = _makeCompatibilityCheck(n.VERSION);
        },
        934: (e, t, r)=>{
            Object.defineProperty(t, "__esModule", {
                value: true
            });
            t.metrics = void 0;
            const n = r(128);
            t.metrics = n.MetricsAPI.getInstance();
        },
        28: (e, t)=>{
            Object.defineProperty(t, "__esModule", {
                value: true
            });
            t.ValueType = void 0;
            var r;
            (function(e) {
                e[e["INT"] = 0] = "INT";
                e[e["DOUBLE"] = 1] = "DOUBLE";
            })(r = t.ValueType || (t.ValueType = {}));
        },
        962: (e, t)=>{
            Object.defineProperty(t, "__esModule", {
                value: true
            });
            t.createNoopMeter = t.NOOP_OBSERVABLE_UP_DOWN_COUNTER_METRIC = t.NOOP_OBSERVABLE_GAUGE_METRIC = t.NOOP_OBSERVABLE_COUNTER_METRIC = t.NOOP_UP_DOWN_COUNTER_METRIC = t.NOOP_HISTOGRAM_METRIC = t.NOOP_COUNTER_METRIC = t.NOOP_METER = t.NoopObservableUpDownCounterMetric = t.NoopObservableGaugeMetric = t.NoopObservableCounterMetric = t.NoopObservableMetric = t.NoopHistogramMetric = t.NoopUpDownCounterMetric = t.NoopCounterMetric = t.NoopMetric = t.NoopMeter = void 0;
            class NoopMeter {
                constructor(){}
                createHistogram(e, r) {
                    return t.NOOP_HISTOGRAM_METRIC;
                }
                createCounter(e, r) {
                    return t.NOOP_COUNTER_METRIC;
                }
                createUpDownCounter(e, r) {
                    return t.NOOP_UP_DOWN_COUNTER_METRIC;
                }
                createObservableGauge(e, r) {
                    return t.NOOP_OBSERVABLE_GAUGE_METRIC;
                }
                createObservableCounter(e, r) {
                    return t.NOOP_OBSERVABLE_COUNTER_METRIC;
                }
                createObservableUpDownCounter(e, r) {
                    return t.NOOP_OBSERVABLE_UP_DOWN_COUNTER_METRIC;
                }
                addBatchObservableCallback(e, t) {}
                removeBatchObservableCallback(e) {}
            }
            t.NoopMeter = NoopMeter;
            class NoopMetric {
            }
            t.NoopMetric = NoopMetric;
            class NoopCounterMetric extends NoopMetric {
                add(e, t) {}
            }
            t.NoopCounterMetric = NoopCounterMetric;
            class NoopUpDownCounterMetric extends NoopMetric {
                add(e, t) {}
            }
            t.NoopUpDownCounterMetric = NoopUpDownCounterMetric;
            class NoopHistogramMetric extends NoopMetric {
                record(e, t) {}
            }
            t.NoopHistogramMetric = NoopHistogramMetric;
            class NoopObservableMetric {
                addCallback(e) {}
                removeCallback(e) {}
            }
            t.NoopObservableMetric = NoopObservableMetric;
            class NoopObservableCounterMetric extends NoopObservableMetric {
            }
            t.NoopObservableCounterMetric = NoopObservableCounterMetric;
            class NoopObservableGaugeMetric extends NoopObservableMetric {
            }
            t.NoopObservableGaugeMetric = NoopObservableGaugeMetric;
            class NoopObservableUpDownCounterMetric extends NoopObservableMetric {
            }
            t.NoopObservableUpDownCounterMetric = NoopObservableUpDownCounterMetric;
            t.NOOP_METER = new NoopMeter;
            t.NOOP_COUNTER_METRIC = new NoopCounterMetric;
            t.NOOP_HISTOGRAM_METRIC = new NoopHistogramMetric;
            t.NOOP_UP_DOWN_COUNTER_METRIC = new NoopUpDownCounterMetric;
            t.NOOP_OBSERVABLE_COUNTER_METRIC = new NoopObservableCounterMetric;
            t.NOOP_OBSERVABLE_GAUGE_METRIC = new NoopObservableGaugeMetric;
            t.NOOP_OBSERVABLE_UP_DOWN_COUNTER_METRIC = new NoopObservableUpDownCounterMetric;
            function createNoopMeter() {
                return t.NOOP_METER;
            }
            t.createNoopMeter = createNoopMeter;
        },
        333: (e, t, r)=>{
            Object.defineProperty(t, "__esModule", {
                value: true
            });
            t.NOOP_METER_PROVIDER = t.NoopMeterProvider = void 0;
            const n = r(962);
            class NoopMeterProvider {
                getMeter(e, t, r) {
                    return n.NOOP_METER;
                }
            }
            t.NoopMeterProvider = NoopMeterProvider;
            t.NOOP_METER_PROVIDER = new NoopMeterProvider;
        },
        966: function(e, t, r) {
            var n = this && this.__createBinding || (Object.create ? function(e, t, r, n) {
                if (n === undefined) n = r;
                Object.defineProperty(e, n, {
                    enumerable: true,
                    get: function() {
                        return t[r];
                    }
                });
            } : function(e, t, r, n) {
                if (n === undefined) n = r;
                e[n] = t[r];
            });
            var a = this && this.__exportStar || function(e, t) {
                for(var r in e)if (r !== "default" && !Object.prototype.hasOwnProperty.call(t, r)) n(t, e, r);
            };
            Object.defineProperty(t, "__esModule", {
                value: true
            });
            a(r(652), t);
        },
        385: (e, t)=>{
            Object.defineProperty(t, "__esModule", {
                value: true
            });
            t._globalThis = void 0;
            t._globalThis = typeof globalThis === "object" ? globalThis : global;
        },
        652: function(e, t, r) {
            var n = this && this.__createBinding || (Object.create ? function(e, t, r, n) {
                if (n === undefined) n = r;
                Object.defineProperty(e, n, {
                    enumerable: true,
                    get: function() {
                        return t[r];
                    }
                });
            } : function(e, t, r, n) {
                if (n === undefined) n = r;
                e[n] = t[r];
            });
            var a = this && this.__exportStar || function(e, t) {
                for(var r in e)if (r !== "default" && !Object.prototype.hasOwnProperty.call(t, r)) n(t, e, r);
            };
            Object.defineProperty(t, "__esModule", {
                value: true
            });
            a(r(385), t);
        },
        251: (e, t, r)=>{
            Object.defineProperty(t, "__esModule", {
                value: true
            });
            t.propagation = void 0;
            const n = r(930);
            t.propagation = n.PropagationAPI.getInstance();
        },
        600: (e, t)=>{
            Object.defineProperty(t, "__esModule", {
                value: true
            });
            t.NoopTextMapPropagator = void 0;
            class NoopTextMapPropagator {
                inject(e, t) {}
                extract(e, t) {
                    return e;
                }
                fields() {
                    return [];
                }
            }
            t.NoopTextMapPropagator = NoopTextMapPropagator;
        },
        625: (e, t)=>{
            Object.defineProperty(t, "__esModule", {
                value: true
            });
            t.defaultTextMapSetter = t.defaultTextMapGetter = void 0;
            t.defaultTextMapGetter = {
                get (e, t) {
                    if (e == null) {
                        return undefined;
                    }
                    return e[t];
                },
                keys (e) {
                    if (e == null) {
                        return [];
                    }
                    return Object.keys(e);
                }
            };
            t.defaultTextMapSetter = {
                set (e, t, r) {
                    if (e == null) {
                        return;
                    }
                    e[t] = r;
                }
            };
        },
        978: (e, t, r)=>{
            Object.defineProperty(t, "__esModule", {
                value: true
            });
            t.trace = void 0;
            const n = r(967);
            t.trace = n.TraceAPI.getInstance();
        },
        76: (e, t, r)=>{
            Object.defineProperty(t, "__esModule", {
                value: true
            });
            t.NonRecordingSpan = void 0;
            const n = r(304);
            class NonRecordingSpan {
                constructor(e = n.INVALID_SPAN_CONTEXT){
                    this._spanContext = e;
                }
                spanContext() {
                    return this._spanContext;
                }
                setAttribute(e, t) {
                    return this;
                }
                setAttributes(e) {
                    return this;
                }
                addEvent(e, t) {
                    return this;
                }
                setStatus(e) {
                    return this;
                }
                updateName(e) {
                    return this;
                }
                end(e) {}
                isRecording() {
                    return false;
                }
                recordException(e, t) {}
            }
            t.NonRecordingSpan = NonRecordingSpan;
        },
        527: (e, t, r)=>{
            Object.defineProperty(t, "__esModule", {
                value: true
            });
            t.NoopTracer = void 0;
            const n = r(339);
            const a = r(542);
            const o = r(76);
            const i = r(994);
            const c = n.ContextAPI.getInstance();
            class NoopTracer {
                startSpan(e, t, r = c.active()) {
                    const n = Boolean(t === null || t === void 0 ? void 0 : t.root);
                    if (n) {
                        return new o.NonRecordingSpan;
                    }
                    const s = r && (0, a.getSpanContext)(r);
                    if (isSpanContext(s) && (0, i.isSpanContextValid)(s)) {
                        return new o.NonRecordingSpan(s);
                    } else {
                        return new o.NonRecordingSpan;
                    }
                }
                startActiveSpan(e, t, r, n) {
                    let o;
                    let i;
                    let s;
                    if (arguments.length < 2) {
                        return;
                    } else if (arguments.length === 2) {
                        s = t;
                    } else if (arguments.length === 3) {
                        o = t;
                        s = r;
                    } else {
                        o = t;
                        i = r;
                        s = n;
                    }
                    const u = i !== null && i !== void 0 ? i : c.active();
                    const l = this.startSpan(e, o, u);
                    const g = (0, a.setSpan)(u, l);
                    return c.with(g, s, undefined, l);
                }
            }
            t.NoopTracer = NoopTracer;
            function isSpanContext(e) {
                return typeof e === "object" && typeof e["spanId"] === "string" && typeof e["traceId"] === "string" && typeof e["traceFlags"] === "number";
            }
        },
        228: (e, t, r)=>{
            Object.defineProperty(t, "__esModule", {
                value: true
            });
            t.NoopTracerProvider = void 0;
            const n = r(527);
            class NoopTracerProvider {
                getTracer(e, t, r) {
                    return new n.NoopTracer;
                }
            }
            t.NoopTracerProvider = NoopTracerProvider;
        },
        387: (e, t, r)=>{
            Object.defineProperty(t, "__esModule", {
                value: true
            });
            t.ProxyTracer = void 0;
            const n = r(527);
            const a = new n.NoopTracer;
            class ProxyTracer {
                constructor(e, t, r, n){
                    this._provider = e;
                    this.name = t;
                    this.version = r;
                    this.options = n;
                }
                startSpan(e, t, r) {
                    return this._getTracer().startSpan(e, t, r);
                }
                startActiveSpan(e, t, r, n) {
                    const a = this._getTracer();
                    return Reflect.apply(a.startActiveSpan, a, arguments);
                }
                _getTracer() {
                    if (this._delegate) {
                        return this._delegate;
                    }
                    const e = this._provider.getDelegateTracer(this.name, this.version, this.options);
                    if (!e) {
                        return a;
                    }
                    this._delegate = e;
                    return this._delegate;
                }
            }
            t.ProxyTracer = ProxyTracer;
        },
        414: (e, t, r)=>{
            Object.defineProperty(t, "__esModule", {
                value: true
            });
            t.ProxyTracerProvider = void 0;
            const n = r(387);
            const a = r(228);
            const o = new a.NoopTracerProvider;
            class ProxyTracerProvider {
                getTracer(e, t, r) {
                    var a;
                    return (a = this.getDelegateTracer(e, t, r)) !== null && a !== void 0 ? a : new n.ProxyTracer(this, e, t, r);
                }
                getDelegate() {
                    var e;
                    return (e = this._delegate) !== null && e !== void 0 ? e : o;
                }
                setDelegate(e) {
                    this._delegate = e;
                }
                getDelegateTracer(e, t, r) {
                    var n;
                    return (n = this._delegate) === null || n === void 0 ? void 0 : n.getTracer(e, t, r);
                }
            }
            t.ProxyTracerProvider = ProxyTracerProvider;
        },
        505: (e, t)=>{
            Object.defineProperty(t, "__esModule", {
                value: true
            });
            t.SamplingDecision = void 0;
            var r;
            (function(e) {
                e[e["NOT_RECORD"] = 0] = "NOT_RECORD";
                e[e["RECORD"] = 1] = "RECORD";
                e[e["RECORD_AND_SAMPLED"] = 2] = "RECORD_AND_SAMPLED";
            })(r = t.SamplingDecision || (t.SamplingDecision = {}));
        },
        542: (e, t, r)=>{
            Object.defineProperty(t, "__esModule", {
                value: true
            });
            t.getSpanContext = t.setSpanContext = t.deleteSpan = t.setSpan = t.getActiveSpan = t.getSpan = void 0;
            const n = r(421);
            const a = r(76);
            const o = r(339);
            const i = (0, n.createContextKey)("OpenTelemetry Context Key SPAN");
            function getSpan(e) {
                return e.getValue(i) || undefined;
            }
            t.getSpan = getSpan;
            function getActiveSpan() {
                return getSpan(o.ContextAPI.getInstance().active());
            }
            t.getActiveSpan = getActiveSpan;
            function setSpan(e, t) {
                return e.setValue(i, t);
            }
            t.setSpan = setSpan;
            function deleteSpan(e) {
                return e.deleteValue(i);
            }
            t.deleteSpan = deleteSpan;
            function setSpanContext(e, t) {
                return setSpan(e, new a.NonRecordingSpan(t));
            }
            t.setSpanContext = setSpanContext;
            function getSpanContext(e) {
                var t;
                return (t = getSpan(e)) === null || t === void 0 ? void 0 : t.spanContext();
            }
            t.getSpanContext = getSpanContext;
        },
        430: (e, t, r)=>{
            Object.defineProperty(t, "__esModule", {
                value: true
            });
            t.TraceStateImpl = void 0;
            const n = r(450);
            const a = 32;
            const o = 512;
            const i = ",";
            const c = "=";
            class TraceStateImpl {
                constructor(e){
                    this._internalState = new Map;
                    if (e) this._parse(e);
                }
                set(e, t) {
                    const r = this._clone();
                    if (r._internalState.has(e)) {
                        r._internalState.delete(e);
                    }
                    r._internalState.set(e, t);
                    return r;
                }
                unset(e) {
                    const t = this._clone();
                    t._internalState.delete(e);
                    return t;
                }
                get(e) {
                    return this._internalState.get(e);
                }
                serialize() {
                    return this._keys().reduce((e, t)=>{
                        e.push(t + c + this.get(t));
                        return e;
                    }, []).join(i);
                }
                _parse(e) {
                    if (e.length > o) return;
                    this._internalState = e.split(i).reverse().reduce((e, t)=>{
                        const r = t.trim();
                        const a = r.indexOf(c);
                        if (a !== -1) {
                            const o = r.slice(0, a);
                            const i = r.slice(a + 1, t.length);
                            if ((0, n.validateKey)(o) && (0, n.validateValue)(i)) {
                                e.set(o, i);
                            } else {}
                        }
                        return e;
                    }, new Map);
                    if (this._internalState.size > a) {
                        this._internalState = new Map(Array.from(this._internalState.entries()).reverse().slice(0, a));
                    }
                }
                _keys() {
                    return Array.from(this._internalState.keys()).reverse();
                }
                _clone() {
                    const e = new TraceStateImpl;
                    e._internalState = new Map(this._internalState);
                    return e;
                }
            }
            t.TraceStateImpl = TraceStateImpl;
        },
        450: (e, t)=>{
            Object.defineProperty(t, "__esModule", {
                value: true
            });
            t.validateValue = t.validateKey = void 0;
            const r = "[_0-9a-z-*/]";
            const n = `[a-z]${r}{0,255}`;
            const a = `[a-z0-9]${r}{0,240}@[a-z]${r}{0,13}`;
            const o = new RegExp(`^(?:${n}|${a})$`);
            const i = /^[ -~]{0,255}[!-~]$/;
            const c = /,|=/;
            function validateKey(e) {
                return o.test(e);
            }
            t.validateKey = validateKey;
            function validateValue(e) {
                return i.test(e) && !c.test(e);
            }
            t.validateValue = validateValue;
        },
        757: (e, t, r)=>{
            Object.defineProperty(t, "__esModule", {
                value: true
            });
            t.createTraceState = void 0;
            const n = r(430);
            function createTraceState(e) {
                return new n.TraceStateImpl(e);
            }
            t.createTraceState = createTraceState;
        },
        304: (e, t, r)=>{
            Object.defineProperty(t, "__esModule", {
                value: true
            });
            t.INVALID_SPAN_CONTEXT = t.INVALID_TRACEID = t.INVALID_SPANID = void 0;
            const n = r(762);
            t.INVALID_SPANID = "0000000000000000";
            t.INVALID_TRACEID = "00000000000000000000000000000000";
            t.INVALID_SPAN_CONTEXT = {
                traceId: t.INVALID_TRACEID,
                spanId: t.INVALID_SPANID,
                traceFlags: n.TraceFlags.NONE
            };
        },
        902: (e, t)=>{
            Object.defineProperty(t, "__esModule", {
                value: true
            });
            t.SpanKind = void 0;
            var r;
            (function(e) {
                e[e["INTERNAL"] = 0] = "INTERNAL";
                e[e["SERVER"] = 1] = "SERVER";
                e[e["CLIENT"] = 2] = "CLIENT";
                e[e["PRODUCER"] = 3] = "PRODUCER";
                e[e["CONSUMER"] = 4] = "CONSUMER";
            })(r = t.SpanKind || (t.SpanKind = {}));
        },
        994: (e, t, r)=>{
            Object.defineProperty(t, "__esModule", {
                value: true
            });
            t.wrapSpanContext = t.isSpanContextValid = t.isValidSpanId = t.isValidTraceId = void 0;
            const n = r(304);
            const a = r(76);
            const o = /^([0-9a-f]{32})$/i;
            const i = /^[0-9a-f]{16}$/i;
            function isValidTraceId(e) {
                return o.test(e) && e !== n.INVALID_TRACEID;
            }
            t.isValidTraceId = isValidTraceId;
            function isValidSpanId(e) {
                return i.test(e) && e !== n.INVALID_SPANID;
            }
            t.isValidSpanId = isValidSpanId;
            function isSpanContextValid(e) {
                return isValidTraceId(e.traceId) && isValidSpanId(e.spanId);
            }
            t.isSpanContextValid = isSpanContextValid;
            function wrapSpanContext(e) {
                return new a.NonRecordingSpan(e);
            }
            t.wrapSpanContext = wrapSpanContext;
        },
        832: (e, t)=>{
            Object.defineProperty(t, "__esModule", {
                value: true
            });
            t.SpanStatusCode = void 0;
            var r;
            (function(e) {
                e[e["UNSET"] = 0] = "UNSET";
                e[e["OK"] = 1] = "OK";
                e[e["ERROR"] = 2] = "ERROR";
            })(r = t.SpanStatusCode || (t.SpanStatusCode = {}));
        },
        762: (e, t)=>{
            Object.defineProperty(t, "__esModule", {
                value: true
            });
            t.TraceFlags = void 0;
            var r;
            (function(e) {
                e[e["NONE"] = 0] = "NONE";
                e[e["SAMPLED"] = 1] = "SAMPLED";
            })(r = t.TraceFlags || (t.TraceFlags = {}));
        },
        520: (e, t)=>{
            Object.defineProperty(t, "__esModule", {
                value: true
            });
            t.VERSION = void 0;
            t.VERSION = "1.4.1";
        }
    };
    var t = {};
    function __nccwpck_require__(r) {
        var n = t[r];
        if (n !== undefined) {
            return n.exports;
        }
        var a = t[r] = {
            exports: {}
        };
        var o = true;
        try {
            e[r].call(a.exports, a, a.exports, __nccwpck_require__);
            o = false;
        } finally{
            if (o) delete t[r];
        }
        return a.exports;
    }
    if (typeof __nccwpck_require__ !== "undefined") __nccwpck_require__.ab = __dirname + "/";
    var r = {};
    (()=>{
        var e = r;
        Object.defineProperty(e, "__esModule", {
            value: true
        });
        e.trace = e.propagation = e.metrics = e.diag = e.context = e.INVALID_SPAN_CONTEXT = e.INVALID_TRACEID = e.INVALID_SPANID = e.isValidSpanId = e.isValidTraceId = e.isSpanContextValid = e.createTraceState = e.TraceFlags = e.SpanStatusCode = e.SpanKind = e.SamplingDecision = e.ProxyTracerProvider = e.ProxyTracer = e.defaultTextMapSetter = e.defaultTextMapGetter = e.ValueType = e.createNoopMeter = e.DiagLogLevel = e.DiagConsoleLogger = e.ROOT_CONTEXT = e.createContextKey = e.baggageEntryMetadataFromString = void 0;
        var t = __nccwpck_require__(701);
        Object.defineProperty(e, "baggageEntryMetadataFromString", {
            enumerable: true,
            get: function() {
                return t.baggageEntryMetadataFromString;
            }
        });
        var n = __nccwpck_require__(421);
        Object.defineProperty(e, "createContextKey", {
            enumerable: true,
            get: function() {
                return n.createContextKey;
            }
        });
        Object.defineProperty(e, "ROOT_CONTEXT", {
            enumerable: true,
            get: function() {
                return n.ROOT_CONTEXT;
            }
        });
        var a = __nccwpck_require__(689);
        Object.defineProperty(e, "DiagConsoleLogger", {
            enumerable: true,
            get: function() {
                return a.DiagConsoleLogger;
            }
        });
        var o = __nccwpck_require__(133);
        Object.defineProperty(e, "DiagLogLevel", {
            enumerable: true,
            get: function() {
                return o.DiagLogLevel;
            }
        });
        var i = __nccwpck_require__(962);
        Object.defineProperty(e, "createNoopMeter", {
            enumerable: true,
            get: function() {
                return i.createNoopMeter;
            }
        });
        var c = __nccwpck_require__(28);
        Object.defineProperty(e, "ValueType", {
            enumerable: true,
            get: function() {
                return c.ValueType;
            }
        });
        var s = __nccwpck_require__(625);
        Object.defineProperty(e, "defaultTextMapGetter", {
            enumerable: true,
            get: function() {
                return s.defaultTextMapGetter;
            }
        });
        Object.defineProperty(e, "defaultTextMapSetter", {
            enumerable: true,
            get: function() {
                return s.defaultTextMapSetter;
            }
        });
        var u = __nccwpck_require__(387);
        Object.defineProperty(e, "ProxyTracer", {
            enumerable: true,
            get: function() {
                return u.ProxyTracer;
            }
        });
        var l = __nccwpck_require__(414);
        Object.defineProperty(e, "ProxyTracerProvider", {
            enumerable: true,
            get: function() {
                return l.ProxyTracerProvider;
            }
        });
        var g = __nccwpck_require__(505);
        Object.defineProperty(e, "SamplingDecision", {
            enumerable: true,
            get: function() {
                return g.SamplingDecision;
            }
        });
        var p = __nccwpck_require__(902);
        Object.defineProperty(e, "SpanKind", {
            enumerable: true,
            get: function() {
                return p.SpanKind;
            }
        });
        var d = __nccwpck_require__(832);
        Object.defineProperty(e, "SpanStatusCode", {
            enumerable: true,
            get: function() {
                return d.SpanStatusCode;
            }
        });
        var _ = __nccwpck_require__(762);
        Object.defineProperty(e, "TraceFlags", {
            enumerable: true,
            get: function() {
                return _.TraceFlags;
            }
        });
        var f = __nccwpck_require__(757);
        Object.defineProperty(e, "createTraceState", {
            enumerable: true,
            get: function() {
                return f.createTraceState;
            }
        });
        var b = __nccwpck_require__(994);
        Object.defineProperty(e, "isSpanContextValid", {
            enumerable: true,
            get: function() {
                return b.isSpanContextValid;
            }
        });
        Object.defineProperty(e, "isValidTraceId", {
            enumerable: true,
            get: function() {
                return b.isValidTraceId;
            }
        });
        Object.defineProperty(e, "isValidSpanId", {
            enumerable: true,
            get: function() {
                return b.isValidSpanId;
            }
        });
        var v = __nccwpck_require__(304);
        Object.defineProperty(e, "INVALID_SPANID", {
            enumerable: true,
            get: function() {
                return v.INVALID_SPANID;
            }
        });
        Object.defineProperty(e, "INVALID_TRACEID", {
            enumerable: true,
            get: function() {
                return v.INVALID_TRACEID;
            }
        });
        Object.defineProperty(e, "INVALID_SPAN_CONTEXT", {
            enumerable: true,
            get: function() {
                return v.INVALID_SPAN_CONTEXT;
            }
        });
        const O = __nccwpck_require__(388);
        Object.defineProperty(e, "context", {
            enumerable: true,
            get: function() {
                return O.context;
            }
        });
        const P = __nccwpck_require__(920);
        Object.defineProperty(e, "diag", {
            enumerable: true,
            get: function() {
                return P.diag;
            }
        });
        const N = __nccwpck_require__(934);
        Object.defineProperty(e, "metrics", {
            enumerable: true,
            get: function() {
                return N.metrics;
            }
        });
        const S = __nccwpck_require__(251);
        Object.defineProperty(e, "propagation", {
            enumerable: true,
            get: function() {
                return S.propagation;
            }
        });
        const C = __nccwpck_require__(978);
        Object.defineProperty(e, "trace", {
            enumerable: true,
            get: function() {
                return C.trace;
            }
        });
        e["default"] = {
            context: O.context,
            diag: P.diag,
            metrics: N.metrics,
            propagation: S.propagation,
            trace: C.trace
        };
    })();
    module.exports = r;
})();


/***/ }),

/***/ 2170:
/***/ ((__unused_webpack_module, exports, __webpack_require__) => {


Object.defineProperty(exports, "__esModule", ({
    value: true
}));
Object.defineProperty(exports, "default", ({
    enumerable: true,
    get: function() {
        return _default;
    }
}));
let chalk;
if (false) {} else {
    chalk = __webpack_require__(4426);
}
const _default = chalk; //# sourceMappingURL=chalk.js.map


/***/ }),

/***/ 9056:
/***/ ((__unused_webpack_module, exports) => {


Object.defineProperty(exports, "__esModule", ({
    value: true
}));
0 && (0);
function _export(target, all) {
    for(var name in all)Object.defineProperty(target, name, {
        enumerable: true,
        get: all[name]
    });
}
_export(exports, {
    NEXT_QUERY_PARAM_PREFIX: function() {
        return NEXT_QUERY_PARAM_PREFIX;
    },
    PRERENDER_REVALIDATE_HEADER: function() {
        return PRERENDER_REVALIDATE_HEADER;
    },
    PRERENDER_REVALIDATE_ONLY_GENERATED_HEADER: function() {
        return PRERENDER_REVALIDATE_ONLY_GENERATED_HEADER;
    },
    CACHE_ONE_YEAR: function() {
        return CACHE_ONE_YEAR;
    },
    MIDDLEWARE_FILENAME: function() {
        return MIDDLEWARE_FILENAME;
    },
    MIDDLEWARE_LOCATION_REGEXP: function() {
        return MIDDLEWARE_LOCATION_REGEXP;
    },
    INSTRUMENTATION_HOOK_FILENAME: function() {
        return INSTRUMENTATION_HOOK_FILENAME;
    },
    INSTRUMENTATION_HOOKS_LOCATION_REGEXP: function() {
        return INSTRUMENTATION_HOOKS_LOCATION_REGEXP;
    },
    PAGES_DIR_ALIAS: function() {
        return PAGES_DIR_ALIAS;
    },
    DOT_NEXT_ALIAS: function() {
        return DOT_NEXT_ALIAS;
    },
    ROOT_DIR_ALIAS: function() {
        return ROOT_DIR_ALIAS;
    },
    APP_DIR_ALIAS: function() {
        return APP_DIR_ALIAS;
    },
    RSC_MOD_REF_PROXY_ALIAS: function() {
        return RSC_MOD_REF_PROXY_ALIAS;
    },
    RSC_ACTION_VALIDATE_ALIAS: function() {
        return RSC_ACTION_VALIDATE_ALIAS;
    },
    RSC_ACTION_PROXY_ALIAS: function() {
        return RSC_ACTION_PROXY_ALIAS;
    },
    RSC_ACTION_CLIENT_WRAPPER_ALIAS: function() {
        return RSC_ACTION_CLIENT_WRAPPER_ALIAS;
    },
    PUBLIC_DIR_MIDDLEWARE_CONFLICT: function() {
        return PUBLIC_DIR_MIDDLEWARE_CONFLICT;
    },
    SSG_GET_INITIAL_PROPS_CONFLICT: function() {
        return SSG_GET_INITIAL_PROPS_CONFLICT;
    },
    SERVER_PROPS_GET_INIT_PROPS_CONFLICT: function() {
        return SERVER_PROPS_GET_INIT_PROPS_CONFLICT;
    },
    SERVER_PROPS_SSG_CONFLICT: function() {
        return SERVER_PROPS_SSG_CONFLICT;
    },
    STATIC_STATUS_PAGE_GET_INITIAL_PROPS_ERROR: function() {
        return STATIC_STATUS_PAGE_GET_INITIAL_PROPS_ERROR;
    },
    SERVER_PROPS_EXPORT_ERROR: function() {
        return SERVER_PROPS_EXPORT_ERROR;
    },
    GSP_NO_RETURNED_VALUE: function() {
        return GSP_NO_RETURNED_VALUE;
    },
    GSSP_NO_RETURNED_VALUE: function() {
        return GSSP_NO_RETURNED_VALUE;
    },
    UNSTABLE_REVALIDATE_RENAME_ERROR: function() {
        return UNSTABLE_REVALIDATE_RENAME_ERROR;
    },
    GSSP_COMPONENT_MEMBER_ERROR: function() {
        return GSSP_COMPONENT_MEMBER_ERROR;
    },
    NON_STANDARD_NODE_ENV: function() {
        return NON_STANDARD_NODE_ENV;
    },
    SSG_FALLBACK_EXPORT_ERROR: function() {
        return SSG_FALLBACK_EXPORT_ERROR;
    },
    ESLINT_DEFAULT_DIRS: function() {
        return ESLINT_DEFAULT_DIRS;
    },
    ESLINT_DEFAULT_DIRS_WITH_APP: function() {
        return ESLINT_DEFAULT_DIRS_WITH_APP;
    },
    ESLINT_PROMPT_VALUES: function() {
        return ESLINT_PROMPT_VALUES;
    },
    SERVER_RUNTIME: function() {
        return SERVER_RUNTIME;
    },
    WEBPACK_LAYERS: function() {
        return WEBPACK_LAYERS;
    },
    WEBPACK_RESOURCE_QUERIES: function() {
        return WEBPACK_RESOURCE_QUERIES;
    }
});
const NEXT_QUERY_PARAM_PREFIX = "nxtP";
const PRERENDER_REVALIDATE_HEADER = "x-prerender-revalidate";
const PRERENDER_REVALIDATE_ONLY_GENERATED_HEADER = "x-prerender-revalidate-if-generated";
const CACHE_ONE_YEAR = 31536000;
const MIDDLEWARE_FILENAME = "middleware";
const MIDDLEWARE_LOCATION_REGEXP = `(?:src/)?${MIDDLEWARE_FILENAME}`;
const INSTRUMENTATION_HOOK_FILENAME = "instrumentation";
const INSTRUMENTATION_HOOKS_LOCATION_REGEXP = `(?:src/)?${INSTRUMENTATION_HOOK_FILENAME}`;
const PAGES_DIR_ALIAS = "private-next-pages";
const DOT_NEXT_ALIAS = "private-dot-next";
const ROOT_DIR_ALIAS = "private-next-root-dir";
const APP_DIR_ALIAS = "private-next-app-dir";
const RSC_MOD_REF_PROXY_ALIAS = "next/dist/build/webpack/loaders/next-flight-loader/module-proxy";
const RSC_ACTION_VALIDATE_ALIAS = "private-next-rsc-action-validate";
const RSC_ACTION_PROXY_ALIAS = "private-next-rsc-action-proxy";
const RSC_ACTION_CLIENT_WRAPPER_ALIAS = "private-next-rsc-action-client-wrapper";
const PUBLIC_DIR_MIDDLEWARE_CONFLICT = `You can not have a '_next' folder inside of your public folder. This conflicts with the internal '/_next' route. https://nextjs.org/docs/messages/public-next-folder-conflict`;
const SSG_GET_INITIAL_PROPS_CONFLICT = `You can not use getInitialProps with getStaticProps. To use SSG, please remove your getInitialProps`;
const SERVER_PROPS_GET_INIT_PROPS_CONFLICT = `You can not use getInitialProps with getServerSideProps. Please remove getInitialProps.`;
const SERVER_PROPS_SSG_CONFLICT = `You can not use getStaticProps or getStaticPaths with getServerSideProps. To use SSG, please remove getServerSideProps`;
const STATIC_STATUS_PAGE_GET_INITIAL_PROPS_ERROR = `can not have getInitialProps/getServerSideProps, https://nextjs.org/docs/messages/404-get-initial-props`;
const SERVER_PROPS_EXPORT_ERROR = `pages with \`getServerSideProps\` can not be exported. See more info here: https://nextjs.org/docs/messages/gssp-export`;
const GSP_NO_RETURNED_VALUE = "Your `getStaticProps` function did not return an object. Did you forget to add a `return`?";
const GSSP_NO_RETURNED_VALUE = "Your `getServerSideProps` function did not return an object. Did you forget to add a `return`?";
const UNSTABLE_REVALIDATE_RENAME_ERROR = "The `unstable_revalidate` property is available for general use.\n" + "Please use `revalidate` instead.";
const GSSP_COMPONENT_MEMBER_ERROR = `can not be attached to a page's component and must be exported from the page. See more info here: https://nextjs.org/docs/messages/gssp-component-member`;
const NON_STANDARD_NODE_ENV = `You are using a non-standard "NODE_ENV" value in your environment. This creates inconsistencies in the project and is strongly advised against. Read more: https://nextjs.org/docs/messages/non-standard-node-env`;
const SSG_FALLBACK_EXPORT_ERROR = `Pages with \`fallback\` enabled in \`getStaticPaths\` can not be exported. See more info here: https://nextjs.org/docs/messages/ssg-fallback-true-export`;
const ESLINT_DEFAULT_DIRS = [
    "pages",
    "components",
    "lib",
    "src"
];
const ESLINT_DEFAULT_DIRS_WITH_APP = [
    "app",
    ...ESLINT_DEFAULT_DIRS
];
const ESLINT_PROMPT_VALUES = [
    {
        title: "Strict",
        recommended: true,
        config: {
            extends: "next/core-web-vitals"
        }
    },
    {
        title: "Base",
        config: {
            extends: "next"
        }
    },
    {
        title: "Cancel",
        config: null
    }
];
const SERVER_RUNTIME = {
    edge: "edge",
    experimentalEdge: "experimental-edge",
    nodejs: "nodejs"
};
const WEBPACK_LAYERS = {
    shared: "sc_shared",
    server: "sc_server",
    client: "sc_client",
    action: "sc_action",
    api: "api",
    middleware: "middleware",
    edgeAsset: "edge-asset",
    appClient: "app-client"
};
const WEBPACK_RESOURCE_QUERIES = {
    edgeSSREntry: "__next_edge_ssr_entry__",
    metadata: "__next_metadata__"
}; //# sourceMappingURL=constants.js.map


/***/ }),

/***/ 7241:
/***/ ((__unused_webpack_module, exports, __webpack_require__) => {


Object.defineProperty(exports, "__esModule", ({
    value: true
}));
0 && (0);
function _export(target, all) {
    for(var name in all)Object.defineProperty(target, name, {
        enumerable: true,
        get: all[name]
    });
}
_export(exports, {
    getCookieParser: function() {
        return getCookieParser;
    },
    sendStatusCode: function() {
        return sendStatusCode;
    },
    redirect: function() {
        return redirect;
    },
    checkIsOnDemandRevalidate: function() {
        return checkIsOnDemandRevalidate;
    },
    COOKIE_NAME_PRERENDER_BYPASS: function() {
        return COOKIE_NAME_PRERENDER_BYPASS;
    },
    COOKIE_NAME_PRERENDER_DATA: function() {
        return COOKIE_NAME_PRERENDER_DATA;
    },
    RESPONSE_LIMIT_DEFAULT: function() {
        return RESPONSE_LIMIT_DEFAULT;
    },
    SYMBOL_PREVIEW_DATA: function() {
        return SYMBOL_PREVIEW_DATA;
    },
    SYMBOL_CLEARED_COOKIES: function() {
        return SYMBOL_CLEARED_COOKIES;
    },
    clearPreviewData: function() {
        return clearPreviewData;
    },
    ApiError: function() {
        return ApiError;
    },
    sendError: function() {
        return sendError;
    },
    setLazyProp: function() {
        return setLazyProp;
    }
});
const _headers = __webpack_require__(6877);
const _constants = __webpack_require__(9056);
function getCookieParser(headers) {
    return function parseCookie() {
        const { cookie } = headers;
        if (!cookie) {
            return {};
        }
        const { parse: parseCookieFn } = __webpack_require__(252);
        return parseCookieFn(Array.isArray(cookie) ? cookie.join("; ") : cookie);
    };
}
function sendStatusCode(res, statusCode) {
    res.statusCode = statusCode;
    return res;
}
function redirect(res, statusOrUrl, url) {
    if (typeof statusOrUrl === "string") {
        url = statusOrUrl;
        statusOrUrl = 307;
    }
    if (typeof statusOrUrl !== "number" || typeof url !== "string") {
        throw new Error(`Invalid redirect arguments. Please use a single argument URL, e.g. res.redirect('/destination') or use a status code and URL, e.g. res.redirect(307, '/destination').`);
    }
    res.writeHead(statusOrUrl, {
        Location: url
    });
    res.write(url);
    res.end();
    return res;
}
function checkIsOnDemandRevalidate(req, previewProps) {
    const headers = _headers.HeadersAdapter.from(req.headers);
    const previewModeId = headers.get(_constants.PRERENDER_REVALIDATE_HEADER);
    const isOnDemandRevalidate = previewModeId === previewProps.previewModeId;
    const revalidateOnlyGenerated = headers.has(_constants.PRERENDER_REVALIDATE_ONLY_GENERATED_HEADER);
    return {
        isOnDemandRevalidate,
        revalidateOnlyGenerated
    };
}
const COOKIE_NAME_PRERENDER_BYPASS = `__prerender_bypass`;
const COOKIE_NAME_PRERENDER_DATA = `__next_preview_data`;
const RESPONSE_LIMIT_DEFAULT = 4 * 1024 * 1024;
const SYMBOL_PREVIEW_DATA = Symbol(COOKIE_NAME_PRERENDER_DATA);
const SYMBOL_CLEARED_COOKIES = Symbol(COOKIE_NAME_PRERENDER_BYPASS);
function clearPreviewData(res, options = {}) {
    if (SYMBOL_CLEARED_COOKIES in res) {
        return res;
    }
    const { serialize } = __webpack_require__(252);
    const previous = res.getHeader("Set-Cookie");
    res.setHeader(`Set-Cookie`, [
        ...typeof previous === "string" ? [
            previous
        ] : Array.isArray(previous) ? previous : [],
        serialize(COOKIE_NAME_PRERENDER_BYPASS, "", {
            // To delete a cookie, set `expires` to a date in the past:
            // https://tools.ietf.org/html/rfc6265#section-4.1.1
            // `Max-Age: 0` is not valid, thus ignored, and the cookie is persisted.
            expires: new Date(0),
            httpOnly: true,
            sameSite:  true ? "none" : 0,
            secure: "production" !== "development",
            path: "/",
            ...options.path !== undefined ? {
                path: options.path
            } : undefined
        }),
        serialize(COOKIE_NAME_PRERENDER_DATA, "", {
            // To delete a cookie, set `expires` to a date in the past:
            // https://tools.ietf.org/html/rfc6265#section-4.1.1
            // `Max-Age: 0` is not valid, thus ignored, and the cookie is persisted.
            expires: new Date(0),
            httpOnly: true,
            sameSite:  true ? "none" : 0,
            secure: "production" !== "development",
            path: "/",
            ...options.path !== undefined ? {
                path: options.path
            } : undefined
        })
    ]);
    Object.defineProperty(res, SYMBOL_CLEARED_COOKIES, {
        value: true,
        enumerable: false
    });
    return res;
}
class ApiError extends Error {
    constructor(statusCode, message){
        super(message);
        this.statusCode = statusCode;
    }
}
function sendError(res, statusCode, message) {
    res.statusCode = statusCode;
    res.statusMessage = message;
    res.end(message);
}
function setLazyProp({ req }, prop, getter) {
    const opts = {
        configurable: true,
        enumerable: true
    };
    const optsReset = {
        ...opts,
        writable: true
    };
    Object.defineProperty(req, prop, {
        ...opts,
        get: ()=>{
            const value = getter();
            // we set the property on the object to avoid recalculating it
            Object.defineProperty(req, prop, {
                ...optsReset,
                value
            });
            return value;
        },
        set: (value)=>{
            Object.defineProperty(req, prop, {
                ...optsReset,
                value
            });
        }
    });
} //# sourceMappingURL=index.js.map


/***/ }),

/***/ 4980:
/***/ ((__unused_webpack_module, exports, __webpack_require__) => {


Object.defineProperty(exports, "__esModule", ({
    value: true
}));
Object.defineProperty(exports, "DraftModeProvider", ({
    enumerable: true,
    get: function() {
        return DraftModeProvider;
    }
}));
const _apiutils = __webpack_require__(7241);
class DraftModeProvider {
    constructor(previewProps, req, cookies, mutableCookies){
        var _cookies_get;
        // The logic for draftMode() is very similar to tryGetPreviewData()
        // but Draft Mode does not have any data associated with it.
        const isOnDemandRevalidate = previewProps && (0, _apiutils.checkIsOnDemandRevalidate)(req, previewProps).isOnDemandRevalidate;
        const cookieValue = (_cookies_get = cookies.get(_apiutils.COOKIE_NAME_PRERENDER_BYPASS)) == null ? void 0 : _cookies_get.value;
        this.isEnabled = Boolean(!isOnDemandRevalidate && cookieValue && previewProps && cookieValue === previewProps.previewModeId);
        this._previewModeId = previewProps == null ? void 0 : previewProps.previewModeId;
        this._mutableCookies = mutableCookies;
    }
    enable() {
        if (!this._previewModeId) {
            throw new Error("Invariant: previewProps missing previewModeId this should never happen");
        }
        this._mutableCookies.set({
            name: _apiutils.COOKIE_NAME_PRERENDER_BYPASS,
            value: this._previewModeId,
            httpOnly: true,
            sameSite:  true ? "none" : 0,
            secure: "production" !== "development",
            path: "/"
        });
    }
    disable() {
        // To delete a cookie, set `expires` to a date in the past:
        // https://tools.ietf.org/html/rfc6265#section-4.1.1
        // `Max-Age: 0` is not valid, thus ignored, and the cookie is persisted.
        this._mutableCookies.set({
            name: _apiutils.COOKIE_NAME_PRERENDER_BYPASS,
            value: "",
            httpOnly: true,
            sameSite:  true ? "none" : 0,
            secure: "production" !== "development",
            path: "/",
            expires: new Date(0)
        });
    }
} //# sourceMappingURL=draft-mode-provider.js.map


/***/ }),

/***/ 9550:
/***/ ((__unused_webpack_module, exports, __webpack_require__) => {


Object.defineProperty(exports, "__esModule", ({
    value: true
}));
Object.defineProperty(exports, "RequestAsyncStorageWrapper", ({
    enumerable: true,
    get: function() {
        return RequestAsyncStorageWrapper;
    }
}));
const _approuterheaders = __webpack_require__(2827);
const _headers = __webpack_require__(6877);
const _requestcookies = __webpack_require__(4895);
const _cookies = __webpack_require__(6454);
const _draftmodeprovider = __webpack_require__(4980);
function getHeaders(headers) {
    const cleaned = _headers.HeadersAdapter.from(headers);
    for (const param of _approuterheaders.FLIGHT_PARAMETERS){
        cleaned.delete(param.toString().toLowerCase());
    }
    return _headers.HeadersAdapter.seal(cleaned);
}
function getCookies(headers) {
    const cookies = new _cookies.RequestCookies(_headers.HeadersAdapter.from(headers));
    return _requestcookies.RequestCookiesAdapter.seal(cookies);
}
function getMutableCookies(headers, res) {
    const cookies = new _cookies.RequestCookies(_headers.HeadersAdapter.from(headers));
    return _requestcookies.MutableRequestCookiesAdapter.wrap(cookies, res);
}
const RequestAsyncStorageWrapper = {
    /**
   * Wrap the callback with the given store so it can access the underlying
   * store using hooks.
   *
   * @param storage underlying storage object returned by the module
   * @param context context to seed the store
   * @param callback function to call within the scope of the context
   * @returns the result returned by the callback
   */ wrap (storage, { req, res, renderOpts }, callback) {
        let previewProps = undefined;
        if (renderOpts && "previewProps" in renderOpts) {
            // TODO: investigate why previewProps isn't on RenderOpts
            previewProps = renderOpts.previewProps;
        }
        const cache = {};
        const store = {
            get headers () {
                if (!cache.headers) {
                    // Seal the headers object that'll freeze out any methods that could
                    // mutate the underlying data.
                    cache.headers = getHeaders(req.headers);
                }
                return cache.headers;
            },
            get cookies () {
                if (!cache.cookies) {
                    // Seal the cookies object that'll freeze out any methods that could
                    // mutate the underlying data.
                    cache.cookies = getCookies(req.headers);
                }
                return cache.cookies;
            },
            get mutableCookies () {
                if (!cache.mutableCookies) {
                    cache.mutableCookies = getMutableCookies(req.headers, res);
                }
                return cache.mutableCookies;
            },
            get draftMode () {
                if (!cache.draftMode) {
                    cache.draftMode = new _draftmodeprovider.DraftModeProvider(previewProps, req, this.cookies, this.mutableCookies);
                }
                return cache.draftMode;
            }
        };
        return storage.run(store, callback, store);
    }
}; //# sourceMappingURL=request-async-storage-wrapper.js.map


/***/ }),

/***/ 1614:
/***/ ((__unused_webpack_module, exports) => {


Object.defineProperty(exports, "__esModule", ({
    value: true
}));
Object.defineProperty(exports, "StaticGenerationAsyncStorageWrapper", ({
    enumerable: true,
    get: function() {
        return StaticGenerationAsyncStorageWrapper;
    }
}));
const StaticGenerationAsyncStorageWrapper = {
    wrap (storage, { pathname, renderOpts }, callback) {
        /**
     * Rules of Static & Dynamic HTML:
     *
     *    1.) We must generate static HTML unless the caller explicitly opts
     *        in to dynamic HTML support.
     *
     *    2.) If dynamic HTML support is requested, we must honor that request
     *        or throw an error. It is the sole responsibility of the caller to
     *        ensure they aren't e.g. requesting dynamic HTML for an AMP page.
     *
     *    3.) If the request is in draft mode, we must generate dynamic HTML.
     *
     * These rules help ensure that other existing features like request caching,
     * coalescing, and ISR continue working as intended.
     */ const isStaticGeneration = !renderOpts.supportsDynamicHTML && !renderOpts.isBot && !renderOpts.isDraftMode;
        const store = {
            isStaticGeneration,
            pathname,
            originalPathname: renderOpts.originalPathname,
            incrementalCache: // so that it can access the fs cache without mocks
            renderOpts.incrementalCache || globalThis.__incrementalCache,
            isRevalidate: renderOpts.isRevalidate,
            isPrerendering: renderOpts.nextExport,
            fetchCache: renderOpts.fetchCache,
            isOnDemandRevalidate: renderOpts.isOnDemandRevalidate
        };
        // TODO: remove this when we resolve accessing the store outside the execution context
        renderOpts.store = store;
        return storage.run(store, callback, store);
    }
}; //# sourceMappingURL=static-generation-async-storage-wrapper.js.map


/***/ }),

/***/ 4191:
/***/ ((__unused_webpack_module, exports, __webpack_require__) => {


Object.defineProperty(exports, "__esModule", ({
    value: true
}));
Object.defineProperty(exports, "autoImplementMethods", ({
    enumerable: true,
    get: function() {
        return autoImplementMethods;
    }
}));
const _http = __webpack_require__(1016);
const _responsehandlers = __webpack_require__(345);
const AUTOMATIC_ROUTE_METHODS = [
    "HEAD",
    "OPTIONS"
];
function autoImplementMethods(handlers) {
    // Loop through all the HTTP methods to create the initial methods object.
    // Each of the methods will be set to the the 405 response handler.
    const methods = _http.HTTP_METHODS.reduce((acc, method)=>({
            ...acc,
            // If the userland module implements the method, then use it. Otherwise,
            // use the 405 response handler.
            [method]: handlers[method] ?? _responsehandlers.handleMethodNotAllowedResponse
        }), {});
    // Get all the methods that could be automatically implemented that were not
    // implemented by the userland module.
    const implemented = new Set(_http.HTTP_METHODS.filter((method)=>handlers[method]));
    const missing = AUTOMATIC_ROUTE_METHODS.filter((method)=>!implemented.has(method));
    // Loop over the missing methods to automatically implement them if we can.
    for (const method of missing){
        // If the userland module doesn't implement the HEAD method, then
        // we'll automatically implement it by calling the GET method (if it
        // exists).
        if (method === "HEAD") {
            // If the userland module doesn't implement the GET method, then
            // we're done.
            if (!handlers.GET) break;
            // Implement the HEAD method by calling the GET method.
            methods.HEAD = handlers.GET;
            // Mark it as implemented.
            implemented.add("HEAD");
            continue;
        }
        // If OPTIONS is not provided then implement it.
        if (method === "OPTIONS") {
            // TODO: check if HEAD is implemented, if so, use it to add more headers
            // Get all the methods that were implemented by the userland module.
            const allow = [
                "OPTIONS",
                ...implemented
            ];
            // If the list of methods doesn't include HEAD, but it includes GET, then
            // add HEAD as it's automatically implemented.
            if (!implemented.has("HEAD") && implemented.has("GET")) {
                allow.push("HEAD");
            }
            // Sort and join the list with commas to create the `Allow` header. See:
            // https://httpwg.org/specs/rfc9110.html#field.allow
            const headers = {
                Allow: allow.sort().join(", ")
            };
            // Implement the OPTIONS method by returning a 204 response with the
            // `Allow` header.
            methods.OPTIONS = ()=>new Response(null, {
                    status: 204,
                    headers
                });
            // Mark this method as implemented.
            implemented.add("OPTIONS");
            continue;
        }
        throw new Error(`Invariant: should handle all automatic implementable methods, got method: ${method}`);
    }
    return methods;
} //# sourceMappingURL=auto-implement-methods.js.map


/***/ }),

/***/ 5546:
/***/ ((__unused_webpack_module, exports) => {

/**
 * Cleans a URL by stripping the protocol, host, and search params.
 *
 * @param urlString the url to clean
 * @returns the cleaned url
 */ 
Object.defineProperty(exports, "__esModule", ({
    value: true
}));
Object.defineProperty(exports, "cleanURL", ({
    enumerable: true,
    get: function() {
        return cleanURL;
    }
}));
function cleanURL(urlString) {
    const url = new URL(urlString);
    url.host = "localhost:3000";
    url.search = "";
    url.protocol = "http";
    return url.toString();
} //# sourceMappingURL=clean-url.js.map


/***/ }),

/***/ 6244:
/***/ ((__unused_webpack_module, exports) => {


Object.defineProperty(exports, "__esModule", ({
    value: true
}));
Object.defineProperty(exports, "getNonStaticMethods", ({
    enumerable: true,
    get: function() {
        return getNonStaticMethods;
    }
}));
const NON_STATIC_METHODS = [
    "OPTIONS",
    "POST",
    "PUT",
    "DELETE",
    "PATCH"
];
function getNonStaticMethods(handlers) {
    // We can currently only statically optimize if only GET/HEAD are used as
    // prerender can't be used conditionally based on the method currently.
    const methods = NON_STATIC_METHODS.filter((method)=>handlers[method]);
    if (methods.length === 0) return false;
    return methods;
} //# sourceMappingURL=get-non-static-methods.js.map


/***/ }),

/***/ 5538:
/***/ ((__unused_webpack_module, exports) => {

/**
 * Get pathname from absolute path.
 *
 * @param absolutePath the absolute path
 * @returns the pathname
 */ 
Object.defineProperty(exports, "__esModule", ({
    value: true
}));
Object.defineProperty(exports, "getPathnameFromAbsolutePath", ({
    enumerable: true,
    get: function() {
        return getPathnameFromAbsolutePath;
    }
}));
function getPathnameFromAbsolutePath(absolutePath) {
    // Remove prefix including app dir
    let appDir = "/app/";
    if (!absolutePath.includes(appDir)) {
        appDir = "\\app\\";
    }
    const [, ...parts] = absolutePath.split(appDir);
    const relativePath = appDir[0] + parts.join(appDir);
    // remove extension
    const pathname = relativePath.split(".").slice(0, -1).join(".");
    return pathname;
} //# sourceMappingURL=get-pathname-from-absolute-path.js.map


/***/ }),

/***/ 4162:
/***/ ((__unused_webpack_module, exports, __webpack_require__) => {


Object.defineProperty(exports, "__esModule", ({
    value: true
}));
Object.defineProperty(exports, "proxyRequest", ({
    enumerable: true,
    get: function() {
        return proxyRequest;
    }
}));
const _cookies = __webpack_require__(7783);
const _nexturl = __webpack_require__(7745);
const _cleanurl = __webpack_require__(5546);
function proxyRequest(request, { dynamic }, hooks) {
    function handleNextUrlBailout(prop) {
        switch(prop){
            case "search":
            case "searchParams":
            case "toString":
            case "href":
            case "origin":
                hooks.staticGenerationBailout(`nextUrl.${prop}`);
                return;
            default:
                return;
        }
    }
    const cache = {};
    const handleForceStatic = (url, prop)=>{
        switch(prop){
            case "search":
                return "";
            case "searchParams":
                if (!cache.searchParams) cache.searchParams = new URLSearchParams();
                return cache.searchParams;
            case "url":
            case "href":
                if (!cache.url) cache.url = (0, _cleanurl.cleanURL)(url);
                return cache.url;
            case "toJSON":
            case "toString":
                if (!cache.url) cache.url = (0, _cleanurl.cleanURL)(url);
                if (!cache.toString) cache.toString = ()=>cache.url;
                return cache.toString;
            case "headers":
                if (!cache.headers) cache.headers = new Headers();
                return cache.headers;
            case "cookies":
                if (!cache.headers) cache.headers = new Headers();
                if (!cache.cookies) cache.cookies = new _cookies.RequestCookies(cache.headers);
                return cache.cookies;
            case "clone":
                if (!cache.url) cache.url = (0, _cleanurl.cleanURL)(url);
                return ()=>new _nexturl.NextURL(cache.url);
            default:
                break;
        }
    };
    const wrappedNextUrl = new Proxy(request.nextUrl, {
        get (target, prop) {
            handleNextUrlBailout(prop);
            if (dynamic === "force-static" && typeof prop === "string") {
                const result = handleForceStatic(target.href, prop);
                if (result !== undefined) return result;
            }
            const value = target[prop];
            if (typeof value === "function") {
                return value.bind(target);
            }
            return value;
        },
        set (target, prop, value) {
            handleNextUrlBailout(prop);
            target[prop] = value;
            return true;
        }
    });
    const handleReqBailout = (prop)=>{
        switch(prop){
            case "headers":
                hooks.headerHooks.headers();
                return;
            // if request.url is accessed directly instead of
            // request.nextUrl we bail since it includes query
            // values that can be relied on dynamically
            case "url":
            case "body":
            case "blob":
            case "json":
            case "text":
            case "arrayBuffer":
            case "formData":
                hooks.staticGenerationBailout(`request.${prop}`);
                return;
            default:
                return;
        }
    };
    return new Proxy(request, {
        get (target, prop) {
            handleReqBailout(prop);
            if (prop === "nextUrl") {
                return wrappedNextUrl;
            }
            if (dynamic === "force-static" && typeof prop === "string") {
                const result = handleForceStatic(target.url, prop);
                if (result !== undefined) return result;
            }
            const value = target[prop];
            if (typeof value === "function") {
                return value.bind(target);
            }
            return value;
        },
        set (target, prop, value) {
            handleReqBailout(prop);
            target[prop] = value;
            return true;
        }
    });
} //# sourceMappingURL=proxy-request.js.map


/***/ }),

/***/ 8460:
/***/ ((__unused_webpack_module, exports, __webpack_require__) => {


Object.defineProperty(exports, "__esModule", ({
    value: true
}));
Object.defineProperty(exports, "resolveHandlerError", ({
    enumerable: true,
    get: function() {
        return resolveHandlerError;
    }
}));
const _notfound = __webpack_require__(6966);
const _redirect = __webpack_require__(8043);
const _responsehandlers = __webpack_require__(345);
function resolveHandlerError(err) {
    if ((0, _redirect.isRedirectError)(err)) {
        const redirect = (0, _redirect.getURLFromRedirectError)(err);
        if (!redirect) {
            throw new Error("Invariant: Unexpected redirect url format");
        }
        // This is a redirect error! Send the redirect response.
        return (0, _responsehandlers.handleTemporaryRedirectResponse)(redirect, err.mutableCookies);
    }
    if ((0, _notfound.isNotFoundError)(err)) {
        // This is a not found error! Send the not found response.
        return (0, _responsehandlers.handleNotFoundResponse)();
    }
    // Return false to indicate that this is not a handled error.
    return false;
} //# sourceMappingURL=resolve-handler-error.js.map


/***/ }),

/***/ 9378:
/***/ ((__unused_webpack_module, exports, __webpack_require__) => {


Object.defineProperty(exports, "__esModule", ({
    value: true
}));
0 && (0);
function _export(target, all) {
    for(var name in all)Object.defineProperty(target, name, {
        enumerable: true,
        get: all[name]
    });
}
_export(exports, {
    AppRouteRouteModule: function() {
        return AppRouteRouteModule;
    },
    default: function() {
        return _default;
    }
});
const _routemodule = __webpack_require__(3089);
const _requestasyncstoragewrapper = __webpack_require__(9550);
const _staticgenerationasyncstoragewrapper = __webpack_require__(1614);
const _responsehandlers = __webpack_require__(345);
const _http = __webpack_require__(1016);
const _patchfetch = __webpack_require__(1075);
const _tracer = __webpack_require__(6467);
const _constants = __webpack_require__(7640);
const _getpathnamefromabsolutepath = __webpack_require__(5538);
const _proxyrequest = __webpack_require__(4162);
const _resolvehandlererror = __webpack_require__(8460);
const _log = /*#__PURE__*/ _interop_require_wildcard(__webpack_require__(2093));
const _autoimplementmethods = __webpack_require__(4191);
const _getnonstaticmethods = __webpack_require__(6244);
const _requestcookies = __webpack_require__(4895);
function _getRequireWildcardCache(nodeInterop) {
    if (typeof WeakMap !== "function") return null;
    var cacheBabelInterop = new WeakMap();
    var cacheNodeInterop = new WeakMap();
    return (_getRequireWildcardCache = function(nodeInterop) {
        return nodeInterop ? cacheNodeInterop : cacheBabelInterop;
    })(nodeInterop);
}
function _interop_require_wildcard(obj, nodeInterop) {
    if (!nodeInterop && obj && obj.__esModule) {
        return obj;
    }
    if (obj === null || typeof obj !== "object" && typeof obj !== "function") {
        return {
            default: obj
        };
    }
    var cache = _getRequireWildcardCache(nodeInterop);
    if (cache && cache.has(obj)) {
        return cache.get(obj);
    }
    var newObj = {};
    var hasPropertyDescriptor = Object.defineProperty && Object.getOwnPropertyDescriptor;
    for(var key in obj){
        if (key !== "default" && Object.prototype.hasOwnProperty.call(obj, key)) {
            var desc = hasPropertyDescriptor ? Object.getOwnPropertyDescriptor(obj, key) : null;
            if (desc && (desc.get || desc.set)) {
                Object.defineProperty(newObj, key, desc);
            } else {
                newObj[key] = obj[key];
            }
        }
    }
    newObj.default = obj;
    if (cache) {
        cache.set(obj, newObj);
    }
    return newObj;
}
// These are imported weirdly like this because of the way that the bundling
// works. We need to import the built files from the dist directory, but we
// can't do that directly because we need types from the source files. So we
// import the types from the source files and then import the built files.
const { requestAsyncStorage } = __webpack_require__(5344);
const { staticGenerationAsyncStorage } = __webpack_require__(2704);
const serverHooks = __webpack_require__(7264);
const headerHooks = __webpack_require__(5117);
const { staticGenerationBailout } = __webpack_require__(6675);
const { actionAsyncStorage } = __webpack_require__(8277);
class AppRouteRouteModule extends _routemodule.RouteModule {
    constructor({ userland, definition, resolvedPagePath, nextConfigOutput }){
        super({
            userland,
            definition
        });
        /**
   * A reference to the request async storage.
   */ this.requestAsyncStorage = requestAsyncStorage;
        /**
   * A reference to the static generation async storage.
   */ this.staticGenerationAsyncStorage = staticGenerationAsyncStorage;
        /**
   * An interface to call server hooks which interact with the underlying
   * storage.
   */ this.serverHooks = serverHooks;
        /**
   * An interface to call header hooks which interact with the underlying
   * request storage.
   */ this.headerHooks = headerHooks;
        /**
   * An interface to call static generation bailout hooks which interact with
   * the underlying static generation storage.
   */ this.staticGenerationBailout = staticGenerationBailout;
        /**
   * A reference to the mutation related async storage, such as mutations of
   * cookies.
   */ this.actionAsyncStorage = actionAsyncStorage;
        /**
   * When true, indicates that the global interfaces have been patched via the
   * `patch()` method.
   */ this.hasSetup = false;
        this.resolvedPagePath = resolvedPagePath;
        this.nextConfigOutput = nextConfigOutput;
        // Automatically implement some methods if they aren't implemented by the
        // userland module.
        this.methods = (0, _autoimplementmethods.autoImplementMethods)(userland);
        // Get the non-static methods for this route.
        this.nonStaticMethods = (0, _getnonstaticmethods.getNonStaticMethods)(userland);
        // Get the dynamic property from the userland module.
        this.dynamic = this.userland.dynamic;
        if (this.nextConfigOutput === "export") {
            if (!this.dynamic || this.dynamic === "auto") {
                this.dynamic = "error";
            } else if (this.dynamic === "force-dynamic") {
                throw new Error(`export const dynamic = "force-dynamic" on page "${definition.pathname}" cannot be used with "output: export". See more info here: https://nextjs.org/docs/advanced-features/static-html-export`);
            }
        }
    }
    /**
   * Validates the userland module to ensure the exported methods and properties
   * are valid.
   */ async setup() {
        // If we've already setup, then return.
        if (this.hasSetup) return;
        // Mark the module as setup. The following warnings about the userland
        // module will run if we're in development. If the module files are modified
        // when in development, then the require cache will be busted for it and
        // this method will be called again (resetting the `hasSetup` flag).
        this.hasSetup = true;
        // We only warn in development after here, so return if we're not in
        // development.
        if (false) {}
    }
    /**
   * Resolves the handler function for the given method.
   *
   * @param method the requested method
   * @returns the handler function for the given method
   */ resolve(method) {
        // Ensure that the requested method is a valid method (to prevent RCE's).
        if (!(0, _http.isHTTPMethod)(method)) return _responsehandlers.handleBadRequestResponse;
        // Return the handler.
        return this.methods[method];
    }
    /**
   * Executes the route handler.
   */ async execute(request, context) {
        // Get the handler function for the given method.
        const handler = this.resolve(request.method);
        // Get the context for the request.
        const requestContext = {
            req: request
        };
        requestContext.renderOpts = {
            previewProps: context.prerenderManifest.preview
        };
        // Get the context for the static generation.
        const staticGenerationContext = {
            pathname: this.definition.pathname,
            renderOpts: // the default values.
            context.staticGenerationContext ?? {
                supportsDynamicHTML: false
            }
        };
        // Add the fetchCache option to the renderOpts.
        staticGenerationContext.renderOpts.fetchCache = this.userland.fetchCache;
        // Run the handler with the request AsyncLocalStorage to inject the helper
        // support. We set this to `unknown` because the type is not known until
        // runtime when we do a instanceof check below.
        const response = await this.actionAsyncStorage.run({
            isAppRoute: true
        }, ()=>{
            return _requestasyncstoragewrapper.RequestAsyncStorageWrapper.wrap(this.requestAsyncStorage, requestContext, ()=>{
                return _staticgenerationasyncstoragewrapper.StaticGenerationAsyncStorageWrapper.wrap(this.staticGenerationAsyncStorage, staticGenerationContext, (staticGenerationStore)=>{
                    var _getTracer_getRootSpanAttributes;
                    // Check to see if we should bail out of static generation based on
                    // having non-static methods.
                    if (this.nonStaticMethods) {
                        this.staticGenerationBailout(`non-static methods used ${this.nonStaticMethods.join(", ")}`);
                    }
                    // Update the static generation store based on the dynamic property.
                    switch(this.dynamic){
                        case "force-dynamic":
                            // The dynamic property is set to force-dynamic, so we should
                            // force the page to be dynamic.
                            staticGenerationStore.forceDynamic = true;
                            this.staticGenerationBailout(`force-dynamic`, {
                                dynamic: this.dynamic
                            });
                            break;
                        case "force-static":
                            // The dynamic property is set to force-static, so we should
                            // force the page to be static.
                            staticGenerationStore.forceStatic = true;
                            break;
                        case "error":
                            // The dynamic property is set to error, so we should throw an
                            // error if the page is being statically generated.
                            staticGenerationStore.dynamicShouldError = true;
                            break;
                        default:
                            break;
                    }
                    // If the static generation store does not have a revalidate value
                    // set, then we should set it the revalidate value from the userland
                    // module or default to false.
                    staticGenerationStore.revalidate ??= this.userland.revalidate ?? false;
                    // Wrap the request so we can add additional functionality to cases
                    // that might change it's output or affect the rendering.
                    const wrappedRequest = (0, _proxyrequest.proxyRequest)(request, {
                        dynamic: this.dynamic
                    }, {
                        headerHooks: this.headerHooks,
                        serverHooks: this.serverHooks,
                        staticGenerationBailout: this.staticGenerationBailout
                    });
                    // TODO: propagate this pathname from route matcher
                    const route = (0, _getpathnamefromabsolutepath.getPathnameFromAbsolutePath)(this.resolvedPagePath);
                    (_getTracer_getRootSpanAttributes = (0, _tracer.getTracer)().getRootSpanAttributes()) == null ? void 0 : _getTracer_getRootSpanAttributes.set("next.route", route);
                    return (0, _tracer.getTracer)().trace(_constants.AppRouteRouteHandlersSpan.runHandler, {
                        spanName: `executing api route (app) ${route}`,
                        attributes: {
                            "next.route": route
                        }
                    }, async ()=>{
                        var _staticGenerationStore_tags;
                        // Patch the global fetch.
                        (0, _patchfetch.patchFetch)({
                            serverHooks: this.serverHooks,
                            staticGenerationAsyncStorage: this.staticGenerationAsyncStorage
                        });
                        const res = await handler(wrappedRequest, {
                            params: context.params
                        });
                        context.staticGenerationContext.fetchMetrics = staticGenerationStore.fetchMetrics;
                        await Promise.all(staticGenerationStore.pendingRevalidates || []);
                        (0, _patchfetch.addImplicitTags)(staticGenerationStore);
                        context.staticGenerationContext.fetchTags = (_staticGenerationStore_tags = staticGenerationStore.tags) == null ? void 0 : _staticGenerationStore_tags.join(",");
                        // It's possible cookies were set in the handler, so we need
                        // to merge the modified cookies and the returned response
                        // here.
                        const requestStore = this.requestAsyncStorage.getStore();
                        if (requestStore && requestStore.mutableCookies) {
                            const headers = new Headers(res.headers);
                            if ((0, _requestcookies.appendMutableCookies)(headers, requestStore.mutableCookies)) {
                                return new Response(res.body, {
                                    status: res.status,
                                    statusText: res.statusText,
                                    headers
                                });
                            }
                        }
                        return res;
                    });
                });
            });
        });
        // If the handler did't return a valid response, then return the internal
        // error response.
        if (!(response instanceof Response)) {
            // TODO: validate the correct handling behavior, maybe log something?
            return (0, _responsehandlers.handleInternalServerErrorResponse)();
        }
        if (response.headers.has("x-middleware-rewrite")) {
            // TODO: move this error into the `NextResponse.rewrite()` function.
            // TODO-APP: re-enable support below when we can proxy these type of requests
            throw new Error("NextResponse.rewrite() was used in a app route handler, this is not currently supported. Please remove the invocation to continue.");
        // // This is a rewrite created via `NextResponse.rewrite()`. We need to send
        // // the response up so it can be handled by the backing server.
        // // If the server is running in minimal mode, we just want to forward the
        // // response (including the rewrite headers) upstream so it can perform the
        // // redirect for us, otherwise return with the special condition so this
        // // server can perform a rewrite.
        // if (!minimalMode) {
        //   return { response, condition: 'rewrite' }
        // }
        // // Relativize the url so it's relative to the base url. This is so the
        // // outgoing headers upstream can be relative.
        // const rewritePath = response.headers.get('x-middleware-rewrite')!
        // const initUrl = getRequestMeta(req, '__NEXT_INIT_URL')!
        // const { pathname } = parseUrl(relativizeURL(rewritePath, initUrl))
        // response.headers.set('x-middleware-rewrite', pathname)
        }
        if (response.headers.get("x-middleware-next") === "1") {
            // TODO: move this error into the `NextResponse.next()` function.
            throw new Error("NextResponse.next() was used in a app route handler, this is not supported. See here for more info: https://nextjs.org/docs/messages/next-response-next-in-app-route-handler");
        }
        return response;
    }
    async handle(request, context) {
        try {
            // Execute the route to get the response.
            const response = await this.execute(request, context);
            // The response was handled, return it.
            return response;
        } catch (err) {
            // Try to resolve the error to a response, else throw it again.
            const response = (0, _resolvehandlererror.resolveHandlerError)(err);
            if (!response) throw err;
            // The response was resolved, return it.
            return response;
        }
    }
}
const _default = AppRouteRouteModule; //# sourceMappingURL=module.js.map


/***/ }),

/***/ 345:
/***/ ((__unused_webpack_module, exports, __webpack_require__) => {


Object.defineProperty(exports, "__esModule", ({
    value: true
}));
0 && (0);
function _export(target, all) {
    for(var name in all)Object.defineProperty(target, name, {
        enumerable: true,
        get: all[name]
    });
}
_export(exports, {
    handleTemporaryRedirectResponse: function() {
        return handleTemporaryRedirectResponse;
    },
    handleBadRequestResponse: function() {
        return handleBadRequestResponse;
    },
    handleNotFoundResponse: function() {
        return handleNotFoundResponse;
    },
    handleMethodNotAllowedResponse: function() {
        return handleMethodNotAllowedResponse;
    },
    handleInternalServerErrorResponse: function() {
        return handleInternalServerErrorResponse;
    }
});
const _requestcookies = __webpack_require__(4895);
function handleTemporaryRedirectResponse(url, mutableCookies) {
    const headers = new Headers({
        location: url
    });
    (0, _requestcookies.appendMutableCookies)(headers, mutableCookies);
    return new Response(null, {
        status: 307,
        headers
    });
}
function handleBadRequestResponse() {
    return new Response(null, {
        status: 400
    });
}
function handleNotFoundResponse() {
    return new Response(null, {
        status: 404
    });
}
function handleMethodNotAllowedResponse() {
    return new Response(null, {
        status: 405
    });
}
function handleInternalServerErrorResponse() {
    return new Response(null, {
        status: 500
    });
} //# sourceMappingURL=response-handlers.js.map


/***/ }),

/***/ 3089:
/***/ ((__unused_webpack_module, exports) => {


Object.defineProperty(exports, "__esModule", ({
    value: true
}));
Object.defineProperty(exports, "RouteModule", ({
    enumerable: true,
    get: function() {
        return RouteModule;
    }
}));
class RouteModule {
    constructor({ userland, definition }){
        this.userland = userland;
        this.definition = definition;
    }
} //# sourceMappingURL=route-module.js.map


/***/ }),

/***/ 1075:
/***/ ((__unused_webpack_module, exports, __webpack_require__) => {


Object.defineProperty(exports, "__esModule", ({
    value: true
}));
0 && (0);
function _export(target, all) {
    for(var name in all)Object.defineProperty(target, name, {
        enumerable: true,
        get: all[name]
    });
}
_export(exports, {
    addImplicitTags: function() {
        return addImplicitTags;
    },
    patchFetch: function() {
        return patchFetch;
    }
});
const _constants = __webpack_require__(7640);
const _tracer = __webpack_require__(6467);
const _constants1 = __webpack_require__(9056);
const isEdgeRuntime = "nodejs" === "edge";
function addImplicitTags(staticGenerationStore) {
    const newTags = [];
    const pathname = staticGenerationStore == null ? void 0 : staticGenerationStore.originalPathname;
    if (!pathname) {
        return newTags;
    }
    if (!Array.isArray(staticGenerationStore.tags)) {
        staticGenerationStore.tags = [];
    }
    if (!staticGenerationStore.tags.includes(pathname)) {
        staticGenerationStore.tags.push(pathname);
    }
    newTags.push(pathname);
    return newTags;
}
function trackFetchMetric(staticGenerationStore, ctx) {
    if (!staticGenerationStore) return;
    if (!staticGenerationStore.fetchMetrics) {
        staticGenerationStore.fetchMetrics = [];
    }
    const dedupeFields = [
        "url",
        "status",
        "method"
    ];
    // don't add metric if one already exists for the fetch
    if (staticGenerationStore.fetchMetrics.some((metric)=>{
        return dedupeFields.every((field)=>metric[field] === ctx[field]);
    })) {
        return;
    }
    staticGenerationStore.fetchMetrics.push({
        url: ctx.url,
        cacheStatus: ctx.cacheStatus,
        status: ctx.status,
        method: ctx.method,
        start: ctx.start,
        end: Date.now(),
        idx: staticGenerationStore.nextFetchId || 0
    });
}
function patchFetch({ serverHooks, staticGenerationAsyncStorage }) {
    if (!globalThis._nextOriginalFetch) {
        globalThis._nextOriginalFetch = globalThis.fetch;
    }
    if (globalThis.fetch.__nextPatched) return;
    const { DynamicServerError } = serverHooks;
    const originFetch = globalThis._nextOriginalFetch;
    globalThis.fetch = async (input, init)=>{
        var _init_method;
        let url;
        try {
            url = new URL(input instanceof Request ? input.url : input);
            url.username = "";
            url.password = "";
        } catch  {
            // Error caused by malformed URL should be handled by native fetch
            url = undefined;
        }
        const fetchUrl = (url == null ? void 0 : url.href) ?? "";
        const fetchStart = Date.now();
        const method = (init == null ? void 0 : (_init_method = init.method) == null ? void 0 : _init_method.toUpperCase()) || "GET";
        return await (0, _tracer.getTracer)().trace(_constants.AppRenderSpan.fetch, {
            kind: _tracer.SpanKind.CLIENT,
            spanName: [
                "fetch",
                method,
                fetchUrl
            ].filter(Boolean).join(" "),
            attributes: {
                "http.url": fetchUrl,
                "http.method": method,
                "net.peer.name": url == null ? void 0 : url.hostname,
                "net.peer.port": (url == null ? void 0 : url.port) || undefined
            }
        }, async ()=>{
            var _ref, _getRequestMeta;
            const staticGenerationStore = staticGenerationAsyncStorage.getStore();
            const isRequestInput = input && typeof input === "object" && typeof input.method === "string";
            const getRequestMeta = (field)=>{
                let value = isRequestInput ? input[field] : null;
                return value || (init == null ? void 0 : init[field]);
            };
            // If the staticGenerationStore is not available, we can't do any
            // special treatment of fetch, therefore fallback to the original
            // fetch implementation.
            if (!staticGenerationStore || ((_ref = init == null ? void 0 : init.next) == null ? void 0 : _ref.internal)) {
                return originFetch(input, init);
            }
            let revalidate = undefined;
            const getNextField = (field)=>{
                var _init_next, _init_next1, _input_next;
                return typeof (init == null ? void 0 : (_init_next = init.next) == null ? void 0 : _init_next[field]) !== "undefined" ? init == null ? void 0 : (_init_next1 = init.next) == null ? void 0 : _init_next1[field] : isRequestInput ? (_input_next = input.next) == null ? void 0 : _input_next[field] : undefined;
            };
            // RequestInit doesn't keep extra fields e.g. next so it's
            // only available if init is used separate
            let curRevalidate = getNextField("revalidate");
            const tags = getNextField("tags") || [];
            if (Array.isArray(tags)) {
                if (!staticGenerationStore.tags) {
                    staticGenerationStore.tags = [];
                }
                for (const tag of tags){
                    if (!staticGenerationStore.tags.includes(tag)) {
                        staticGenerationStore.tags.push(tag);
                    }
                }
            }
            const implicitTags = addImplicitTags(staticGenerationStore);
            for (const tag of implicitTags || []){
                if (!tags.includes(tag)) {
                    tags.push(tag);
                }
            }
            const isOnlyCache = staticGenerationStore.fetchCache === "only-cache";
            const isForceCache = staticGenerationStore.fetchCache === "force-cache";
            const isDefaultCache = staticGenerationStore.fetchCache === "default-cache";
            const isDefaultNoStore = staticGenerationStore.fetchCache === "default-no-store";
            const isOnlyNoStore = staticGenerationStore.fetchCache === "only-no-store";
            const isForceNoStore = staticGenerationStore.fetchCache === "force-no-store";
            let _cache = getRequestMeta("cache");
            if (typeof _cache === "string" && typeof curRevalidate !== "undefined") {
                console.warn(`Warning: fetch for ${fetchUrl} on ${staticGenerationStore.pathname} specified "cache: ${_cache}" and "revalidate: ${curRevalidate}", only one should be specified.`);
                _cache = undefined;
            }
            if (_cache === "force-cache") {
                curRevalidate = false;
            }
            if ([
                "no-cache",
                "no-store"
            ].includes(_cache || "")) {
                curRevalidate = 0;
            }
            if (typeof curRevalidate === "number" || curRevalidate === false) {
                revalidate = curRevalidate;
            }
            let cacheReason = "";
            const _headers = getRequestMeta("headers");
            const initHeaders = typeof (_headers == null ? void 0 : _headers.get) === "function" ? _headers : new Headers(_headers || {});
            const hasUnCacheableHeader = initHeaders.get("authorization") || initHeaders.get("cookie");
            const isUnCacheableMethod = ![
                "get",
                "head"
            ].includes(((_getRequestMeta = getRequestMeta("method")) == null ? void 0 : _getRequestMeta.toLowerCase()) || "get");
            // if there are authorized headers or a POST method and
            // dynamic data usage was present above the tree we bail
            // e.g. if cookies() is used before an authed/POST fetch
            const autoNoCache = (hasUnCacheableHeader || isUnCacheableMethod) && staticGenerationStore.revalidate === 0;
            if (isForceNoStore) {
                revalidate = 0;
                cacheReason = "fetchCache = force-no-store";
            }
            if (isOnlyNoStore) {
                if (_cache === "force-cache" || revalidate === 0) {
                    throw new Error(`cache: 'force-cache' used on fetch for ${fetchUrl} with 'export const fetchCache = 'only-no-store'`);
                }
                revalidate = 0;
                cacheReason = "fetchCache = only-no-store";
            }
            if (isOnlyCache && _cache === "no-store") {
                throw new Error(`cache: 'no-store' used on fetch for ${fetchUrl} with 'export const fetchCache = 'only-cache'`);
            }
            if (isForceCache && (typeof curRevalidate === "undefined" || curRevalidate === 0)) {
                cacheReason = "fetchCache = force-cache";
                revalidate = false;
            }
            if (typeof revalidate === "undefined") {
                if (isDefaultCache) {
                    revalidate = false;
                    cacheReason = "fetchCache = default-cache";
                } else if (autoNoCache) {
                    revalidate = 0;
                    cacheReason = "auto no cache";
                } else if (isDefaultNoStore) {
                    revalidate = 0;
                    cacheReason = "fetchCache = default-no-store";
                } else {
                    cacheReason = "auto cache";
                    revalidate = typeof staticGenerationStore.revalidate === "boolean" || typeof staticGenerationStore.revalidate === "undefined" ? false : staticGenerationStore.revalidate;
                }
            } else if (!cacheReason) {
                cacheReason = `revalidate: ${revalidate}`;
            }
            if (// revalidate although if it occurs during build we do
            !autoNoCache && (typeof staticGenerationStore.revalidate === "undefined" || typeof revalidate === "number" && (staticGenerationStore.revalidate === false || typeof staticGenerationStore.revalidate === "number" && revalidate < staticGenerationStore.revalidate))) {
                staticGenerationStore.revalidate = revalidate;
            }
            const isCacheableRevalidate = typeof revalidate === "number" && revalidate > 0 || revalidate === false;
            let cacheKey;
            if (staticGenerationStore.incrementalCache && isCacheableRevalidate) {
                try {
                    cacheKey = await staticGenerationStore.incrementalCache.fetchCacheKey(fetchUrl, isRequestInput ? input : init);
                } catch (err) {
                    console.error(`Failed to generate cache key for`, input);
                }
            }
            const requestInputFields = [
                "cache",
                "credentials",
                "headers",
                "integrity",
                "keepalive",
                "method",
                "mode",
                "redirect",
                "referrer",
                "referrerPolicy",
                "signal",
                "window",
                "duplex"
            ];
            if (isRequestInput) {
                const reqInput = input;
                const reqOptions = {
                    body: reqInput._ogBody || reqInput.body
                };
                for (const field of requestInputFields){
                    // @ts-expect-error custom fields
                    reqOptions[field] = reqInput[field];
                }
                input = new Request(reqInput.url, reqOptions);
            } else if (init) {
                const initialInit = init;
                init = {
                    body: init._ogBody || init.body
                };
                for (const field of requestInputFields){
                    // @ts-expect-error custom fields
                    init[field] = initialInit[field];
                }
            }
            const fetchIdx = staticGenerationStore.nextFetchId ?? 1;
            staticGenerationStore.nextFetchId = fetchIdx + 1;
            const normalizedRevalidate = typeof revalidate !== "number" ? _constants1.CACHE_ONE_YEAR : revalidate;
            const doOriginalFetch = async (isStale)=>{
                // add metadata to init without editing the original
                const clonedInit = {
                    ...init,
                    next: {
                        ...init == null ? void 0 : init.next,
                        fetchType: "origin",
                        fetchIdx
                    }
                };
                return originFetch(input, clonedInit).then(async (res)=>{
                    if (!isStale) {
                        trackFetchMetric(staticGenerationStore, {
                            start: fetchStart,
                            url: fetchUrl,
                            cacheReason,
                            cacheStatus: "miss",
                            status: res.status,
                            method: clonedInit.method || "GET"
                        });
                    }
                    if (res.status === 200 && staticGenerationStore.incrementalCache && cacheKey && isCacheableRevalidate) {
                        const bodyBuffer = Buffer.from(await res.arrayBuffer());
                        try {
                            await staticGenerationStore.incrementalCache.set(cacheKey, {
                                kind: "FETCH",
                                data: {
                                    headers: Object.fromEntries(res.headers.entries()),
                                    body: bodyBuffer.toString("base64"),
                                    status: res.status,
                                    tags
                                },
                                revalidate: normalizedRevalidate
                            }, revalidate, true, fetchUrl, fetchIdx);
                        } catch (err) {
                            console.warn(`Failed to set fetch cache`, input, err);
                        }
                        return new Response(bodyBuffer, {
                            headers: new Headers(res.headers),
                            status: res.status
                        });
                    }
                    return res;
                });
            };
            if (cacheKey && (staticGenerationStore == null ? void 0 : staticGenerationStore.incrementalCache)) {
                const entry = staticGenerationStore.isOnDemandRevalidate ? null : await staticGenerationStore.incrementalCache.get(cacheKey, true, revalidate, fetchUrl, fetchIdx);
                if ((entry == null ? void 0 : entry.value) && entry.value.kind === "FETCH") {
                    const currentTags = entry.value.data.tags;
                    // when stale and is revalidating we wait for fresh data
                    // so the revalidated entry has the updated data
                    if (!(staticGenerationStore.isRevalidate && entry.isStale)) {
                        if (entry.isStale) {
                            if (!staticGenerationStore.pendingRevalidates) {
                                staticGenerationStore.pendingRevalidates = [];
                            }
                            staticGenerationStore.pendingRevalidates.push(doOriginalFetch(true).catch(console.error));
                        } else if (tags && !tags.every((tag)=>{
                            return currentTags == null ? void 0 : currentTags.includes(tag);
                        })) {
                            var _staticGenerationStore_incrementalCache;
                            // if new tags are being added we need to set even if
                            // the data isn't stale
                            if (!entry.value.data.tags) {
                                entry.value.data.tags = [];
                            }
                            for (const tag of tags){
                                if (!entry.value.data.tags.includes(tag)) {
                                    entry.value.data.tags.push(tag);
                                }
                            }
                            (_staticGenerationStore_incrementalCache = staticGenerationStore.incrementalCache) == null ? void 0 : _staticGenerationStore_incrementalCache.set(cacheKey, entry.value, revalidate, true, fetchUrl, fetchIdx);
                        }
                        const resData = entry.value.data;
                        let decodedBody;
                        if (false) {} else {
                            decodedBody = Buffer.from(resData.body, "base64").subarray();
                        }
                        trackFetchMetric(staticGenerationStore, {
                            start: fetchStart,
                            url: fetchUrl,
                            cacheReason,
                            cacheStatus: "hit",
                            status: resData.status || 200,
                            method: (init == null ? void 0 : init.method) || "GET"
                        });
                        return new Response(decodedBody, {
                            headers: resData.headers,
                            status: resData.status
                        });
                    }
                }
            }
            if (staticGenerationStore.isStaticGeneration) {
                if (init && typeof init === "object") {
                    const cache = init.cache;
                    // Delete `cache` property as Cloudflare Workers will throw an error
                    if (isEdgeRuntime) {
                        delete init.cache;
                    }
                    if (cache === "no-store") {
                        staticGenerationStore.revalidate = 0;
                        const dynamicUsageReason = `no-store fetch ${input}${staticGenerationStore.pathname ? ` ${staticGenerationStore.pathname}` : ""}`;
                        const err = new DynamicServerError(dynamicUsageReason);
                        staticGenerationStore.dynamicUsageErr = err;
                        staticGenerationStore.dynamicUsageStack = err.stack;
                        staticGenerationStore.dynamicUsageDescription = dynamicUsageReason;
                    }
                    const hasNextConfig = "next" in init;
                    const next = init.next || {};
                    if (typeof next.revalidate === "number" && (typeof staticGenerationStore.revalidate === "undefined" || typeof staticGenerationStore.revalidate === "number" && next.revalidate < staticGenerationStore.revalidate)) {
                        const forceDynamic = staticGenerationStore.forceDynamic;
                        if (!forceDynamic || next.revalidate !== 0) {
                            staticGenerationStore.revalidate = next.revalidate;
                        }
                        if (!forceDynamic && next.revalidate === 0) {
                            const dynamicUsageReason = `revalidate: ${next.revalidate} fetch ${input}${staticGenerationStore.pathname ? ` ${staticGenerationStore.pathname}` : ""}`;
                            const err = new DynamicServerError(dynamicUsageReason);
                            staticGenerationStore.dynamicUsageErr = err;
                            staticGenerationStore.dynamicUsageStack = err.stack;
                            staticGenerationStore.dynamicUsageDescription = dynamicUsageReason;
                        }
                    }
                    if (hasNextConfig) delete init.next;
                }
            }
            return doOriginalFetch();
        });
    };
    globalThis.fetch.__nextGetStaticStore = ()=>{
        return staticGenerationAsyncStorage;
    };
    globalThis.fetch.__nextPatched = true;
} //# sourceMappingURL=patch-fetch.js.map


/***/ }),

/***/ 7640:
/***/ ((__unused_webpack_module, exports) => {

/**
 * Contains predefined constants for the trace span name in next/server.
 *
 * Currently, next/server/tracer is internal implementation only for tracking
 * next.js's implementation only with known span names defined here.
 **/ // eslint typescript has a bug with TS enums
/* eslint-disable no-shadow */ 
Object.defineProperty(exports, "__esModule", ({
    value: true
}));
0 && (0);
function _export(target, all) {
    for(var name in all)Object.defineProperty(target, name, {
        enumerable: true,
        get: all[name]
    });
}
_export(exports, {
    NextVanillaSpanAllowlist: function() {
        return NextVanillaSpanAllowlist;
    },
    BaseServerSpan: function() {
        return BaseServerSpan;
    },
    LoadComponentsSpan: function() {
        return LoadComponentsSpan;
    },
    NextServerSpan: function() {
        return NextServerSpan;
    },
    NextNodeServerSpan: function() {
        return NextNodeServerSpan;
    },
    StartServerSpan: function() {
        return StartServerSpan;
    },
    RenderSpan: function() {
        return RenderSpan;
    },
    RouterSpan: function() {
        return RouterSpan;
    },
    AppRenderSpan: function() {
        return AppRenderSpan;
    },
    NodeSpan: function() {
        return NodeSpan;
    },
    AppRouteRouteHandlersSpan: function() {
        return AppRouteRouteHandlersSpan;
    },
    ResolveMetadataSpan: function() {
        return ResolveMetadataSpan;
    }
});
var BaseServerSpan;
(function(BaseServerSpan) {
    BaseServerSpan["handleRequest"] = "BaseServer.handleRequest";
    BaseServerSpan["run"] = "BaseServer.run";
    BaseServerSpan["pipe"] = "BaseServer.pipe";
    BaseServerSpan["getStaticHTML"] = "BaseServer.getStaticHTML";
    BaseServerSpan["render"] = "BaseServer.render";
    BaseServerSpan["renderToResponseWithComponents"] = "BaseServer.renderToResponseWithComponents";
    BaseServerSpan["renderToResponse"] = "BaseServer.renderToResponse";
    BaseServerSpan["renderToHTML"] = "BaseServer.renderToHTML";
    BaseServerSpan["renderError"] = "BaseServer.renderError";
    BaseServerSpan["renderErrorToResponse"] = "BaseServer.renderErrorToResponse";
    BaseServerSpan["renderErrorToHTML"] = "BaseServer.renderErrorToHTML";
    BaseServerSpan["render404"] = "BaseServer.render404";
})(BaseServerSpan || (BaseServerSpan = {}));
var LoadComponentsSpan;
(function(LoadComponentsSpan) {
    LoadComponentsSpan["loadDefaultErrorComponents"] = "LoadComponents.loadDefaultErrorComponents";
    LoadComponentsSpan["loadComponents"] = "LoadComponents.loadComponents";
})(LoadComponentsSpan || (LoadComponentsSpan = {}));
var NextServerSpan;
(function(NextServerSpan) {
    NextServerSpan["getRequestHandler"] = "NextServer.getRequestHandler";
    NextServerSpan["getServer"] = "NextServer.getServer";
    NextServerSpan["getServerRequestHandler"] = "NextServer.getServerRequestHandler";
    NextServerSpan["createServer"] = "createServer.createServer";
})(NextServerSpan || (NextServerSpan = {}));
var NextNodeServerSpan;
(function(NextNodeServerSpan) {
    NextNodeServerSpan["compression"] = "NextNodeServer.compression";
    NextNodeServerSpan["getBuildId"] = "NextNodeServer.getBuildId";
    NextNodeServerSpan["generateStaticRoutes"] = "NextNodeServer.generateStaticRoutes";
    NextNodeServerSpan["generateFsStaticRoutes"] = "NextNodeServer.generateFsStaticRoutes";
    NextNodeServerSpan["generatePublicRoutes"] = "NextNodeServer.generatePublicRoutes";
    NextNodeServerSpan["generateImageRoutes"] = "NextNodeServer.generateImageRoutes.route";
    NextNodeServerSpan["sendRenderResult"] = "NextNodeServer.sendRenderResult";
    NextNodeServerSpan["sendStatic"] = "NextNodeServer.sendStatic";
    NextNodeServerSpan["proxyRequest"] = "NextNodeServer.proxyRequest";
    NextNodeServerSpan["runApi"] = "NextNodeServer.runApi";
    NextNodeServerSpan["render"] = "NextNodeServer.render";
    NextNodeServerSpan["renderHTML"] = "NextNodeServer.renderHTML";
    NextNodeServerSpan["imageOptimizer"] = "NextNodeServer.imageOptimizer";
    NextNodeServerSpan["getPagePath"] = "NextNodeServer.getPagePath";
    NextNodeServerSpan["getRoutesManifest"] = "NextNodeServer.getRoutesManifest";
    NextNodeServerSpan["findPageComponents"] = "NextNodeServer.findPageComponents";
    NextNodeServerSpan["getFontManifest"] = "NextNodeServer.getFontManifest";
    NextNodeServerSpan["getServerComponentManifest"] = "NextNodeServer.getServerComponentManifest";
    NextNodeServerSpan["getRequestHandler"] = "NextNodeServer.getRequestHandler";
    NextNodeServerSpan["renderToHTML"] = "NextNodeServer.renderToHTML";
    NextNodeServerSpan["renderError"] = "NextNodeServer.renderError";
    NextNodeServerSpan["renderErrorToHTML"] = "NextNodeServer.renderErrorToHTML";
    NextNodeServerSpan["render404"] = "NextNodeServer.render404";
    NextNodeServerSpan["route"] = "route";
    NextNodeServerSpan["onProxyReq"] = "onProxyReq";
    NextNodeServerSpan["apiResolver"] = "apiResolver";
})(NextNodeServerSpan || (NextNodeServerSpan = {}));
var StartServerSpan;
(function(StartServerSpan) {
    StartServerSpan["startServer"] = "startServer.startServer";
})(StartServerSpan || (StartServerSpan = {}));
var RenderSpan;
(function(RenderSpan) {
    RenderSpan["getServerSideProps"] = "Render.getServerSideProps";
    RenderSpan["getStaticProps"] = "Render.getStaticProps";
    RenderSpan["renderToString"] = "Render.renderToString";
    RenderSpan["renderDocument"] = "Render.renderDocument";
    RenderSpan["createBodyResult"] = "Render.createBodyResult";
})(RenderSpan || (RenderSpan = {}));
var AppRenderSpan;
(function(AppRenderSpan) {
    AppRenderSpan["renderToString"] = "AppRender.renderToString";
    AppRenderSpan["renderToReadableStream"] = "AppRender.renderToReadableStream";
    AppRenderSpan["getBodyResult"] = "AppRender.getBodyResult";
    AppRenderSpan["fetch"] = "AppRender.fetch";
})(AppRenderSpan || (AppRenderSpan = {}));
var RouterSpan;
(function(RouterSpan) {
    RouterSpan["executeRoute"] = "Router.executeRoute";
})(RouterSpan || (RouterSpan = {}));
var NodeSpan;
(function(NodeSpan) {
    NodeSpan["runHandler"] = "Node.runHandler";
})(NodeSpan || (NodeSpan = {}));
var AppRouteRouteHandlersSpan;
(function(AppRouteRouteHandlersSpan) {
    AppRouteRouteHandlersSpan["runHandler"] = "AppRouteRouteHandlers.runHandler";
})(AppRouteRouteHandlersSpan || (AppRouteRouteHandlersSpan = {}));
var ResolveMetadataSpan;
(function(ResolveMetadataSpan) {
    ResolveMetadataSpan["generateMetadata"] = "ResolveMetadata.generateMetadata";
})(ResolveMetadataSpan || (ResolveMetadataSpan = {}));
const NextVanillaSpanAllowlist = [
    "BaseServer.handleRequest",
    "Render.getServerSideProps",
    "Render.getStaticProps",
    "AppRender.fetch",
    "AppRender.getBodyResult",
    "Render.renderDocument",
    "Node.runHandler",
    "AppRouteRouteHandlers.runHandler",
    "ResolveMetadata.generateMetadata"
]; //# sourceMappingURL=constants.js.map


/***/ }),

/***/ 6467:
/***/ ((__unused_webpack_module, exports, __webpack_require__) => {


Object.defineProperty(exports, "__esModule", ({
    value: true
}));
0 && (0);
function _export(target, all) {
    for(var name in all)Object.defineProperty(target, name, {
        enumerable: true,
        get: all[name]
    });
}
_export(exports, {
    getTracer: function() {
        return getTracer;
    },
    SpanStatusCode: function() {
        return SpanStatusCode;
    },
    SpanKind: function() {
        return SpanKind;
    }
});
const _constants = __webpack_require__(7640);
let api;
// we want to allow users to use their own version of @opentelemetry/api if they
// want to, so we try to require it first, and if it fails we fall back to the
// version that is bundled with Next.js
// this is because @opentelemetry/api has to be synced with the version of
// @opentelemetry/tracing that is used, and we don't want to force users to use
// the version that is bundled with Next.js.
// the API is ~stable, so this should be fine
if (false) {} else {
    try {
        api = __webpack_require__(7811);
    } catch (err) {
        api = __webpack_require__(8530);
    }
}
const { context, trace, SpanStatusCode, SpanKind } = api;
const isPromise = (p)=>{
    return p !== null && typeof p === "object" && typeof p.then === "function";
};
const closeSpanWithError = (span, error)=>{
    if (error) {
        span.recordException(error);
    }
    span.setStatus({
        code: SpanStatusCode.ERROR,
        message: error == null ? void 0 : error.message
    });
    span.end();
};
/** we use this map to propagate attributes from nested spans to the top span */ const rootSpanAttributesStore = new Map();
const rootSpanIdKey = api.createContextKey("next.rootSpanId");
let lastSpanId = 0;
const getSpanId = ()=>lastSpanId++;
class NextTracerImpl {
    /**
   * Returns an instance to the trace with configured name.
   * Since wrap / trace can be defined in any place prior to actual trace subscriber initialization,
   * This should be lazily evaluated.
   */ getTracerInstance() {
        return trace.getTracer("next.js", "0.0.1");
    }
    getContext() {
        return context;
    }
    getActiveScopeSpan() {
        return trace.getSpan(context == null ? void 0 : context.active());
    }
    trace(...args) {
        const [type, fnOrOptions, fnOrEmpty] = args;
        // coerce options form overload
        const { fn, options } = typeof fnOrOptions === "function" ? {
            fn: fnOrOptions,
            options: {}
        } : {
            fn: fnOrEmpty,
            options: {
                ...fnOrOptions
            }
        };
        if (!_constants.NextVanillaSpanAllowlist.includes(type) && process.env.NEXT_OTEL_VERBOSE !== "1" || options.hideSpan) {
            return fn();
        }
        const spanName = options.spanName ?? type;
        // Trying to get active scoped span to assign parent. If option specifies parent span manually, will try to use it.
        let spanContext = this.getSpanContext((options == null ? void 0 : options.parentSpan) ?? this.getActiveScopeSpan());
        let isRootSpan = false;
        if (!spanContext) {
            spanContext = api.ROOT_CONTEXT;
            isRootSpan = true;
        }
        const spanId = getSpanId();
        options.attributes = {
            "next.span_name": spanName,
            "next.span_type": type,
            ...options.attributes
        };
        return api.context.with(spanContext.setValue(rootSpanIdKey, spanId), ()=>this.getTracerInstance().startActiveSpan(spanName, options, (span)=>{
                const onCleanup = ()=>{
                    rootSpanAttributesStore.delete(spanId);
                };
                if (isRootSpan) {
                    rootSpanAttributesStore.set(spanId, new Map(Object.entries(options.attributes ?? {})));
                }
                try {
                    if (fn.length > 1) {
                        return fn(span, (err)=>closeSpanWithError(span, err));
                    }
                    const result = fn(span);
                    if (isPromise(result)) {
                        result.then(()=>span.end(), (err)=>closeSpanWithError(span, err)).finally(onCleanup);
                    } else {
                        span.end();
                        onCleanup();
                    }
                    return result;
                } catch (err) {
                    closeSpanWithError(span, err);
                    onCleanup();
                    throw err;
                }
            }));
    }
    wrap(...args) {
        const tracer = this;
        const [name, options, fn] = args.length === 3 ? args : [
            args[0],
            {},
            args[1]
        ];
        if (!_constants.NextVanillaSpanAllowlist.includes(name) && process.env.NEXT_OTEL_VERBOSE !== "1") {
            return fn;
        }
        return function() {
            let optionsObj = options;
            if (typeof optionsObj === "function" && typeof fn === "function") {
                optionsObj = optionsObj.apply(this, arguments);
            }
            const lastArgId = arguments.length - 1;
            const cb = arguments[lastArgId];
            if (typeof cb === "function") {
                const scopeBoundCb = tracer.getContext().bind(context.active(), cb);
                return tracer.trace(name, optionsObj, (_span, done)=>{
                    arguments[lastArgId] = function(err) {
                        done == null ? void 0 : done(err);
                        return scopeBoundCb.apply(this, arguments);
                    };
                    return fn.apply(this, arguments);
                });
            } else {
                return tracer.trace(name, optionsObj, ()=>fn.apply(this, arguments));
            }
        };
    }
    startSpan(...args) {
        const [type, options] = args;
        const spanContext = this.getSpanContext((options == null ? void 0 : options.parentSpan) ?? this.getActiveScopeSpan());
        return this.getTracerInstance().startSpan(type, options, spanContext);
    }
    getSpanContext(parentSpan) {
        const spanContext = parentSpan ? trace.setSpan(context.active(), parentSpan) : undefined;
        return spanContext;
    }
    getRootSpanAttributes() {
        const spanId = context.active().getValue(rootSpanIdKey);
        return rootSpanAttributesStore.get(spanId);
    }
}
const getTracer = (()=>{
    const tracer = new NextTracerImpl();
    return ()=>tracer;
})(); //# sourceMappingURL=tracer.js.map


/***/ }),

/***/ 7778:
/***/ (() => {

/**
 * Polyfills the `Headers.getAll(name)` method so it'll work in the edge
 * runtime.
 */ 
if (!("getAll" in Headers.prototype)) {
    // @ts-expect-error - this is polyfilling this method so it doesn't exist yet
    Headers.prototype.getAll = function(name) {
        name = name.toLowerCase();
        if (name !== "set-cookie") throw new Error("Headers.getAll is only supported for Set-Cookie header");
        const headers = [
            ...this.entries()
        ].filter(([key])=>key === name);
        return headers.map(([, value])=>value);
    };
} //# sourceMappingURL=node-polyfill-headers.js.map


/***/ }),

/***/ 3431:
/***/ ((__unused_webpack_module, exports, __webpack_require__) => {

var __webpack_unused_export__;
// This file is for modularized imports for next/server to get fully-treeshaking.

__webpack_unused_export__ = ({
    value: true
});
Object.defineProperty(exports, "Z", ({
    enumerable: true,
    get: function() {
        return _response.NextResponse;
    }
}));
const _response = __webpack_require__(2044); //# sourceMappingURL=next-response.js.map


/***/ }),

/***/ 1016:
/***/ ((__unused_webpack_module, exports) => {

/**
 * List of valid HTTP methods that can be implemented by Next.js's Custom App
 * Routes.
 */ 
Object.defineProperty(exports, "__esModule", ({
    value: true
}));
0 && (0);
function _export(target, all) {
    for(var name in all)Object.defineProperty(target, name, {
        enumerable: true,
        get: all[name]
    });
}
_export(exports, {
    HTTP_METHODS: function() {
        return HTTP_METHODS;
    },
    isHTTPMethod: function() {
        return isHTTPMethod;
    }
});
const HTTP_METHODS = [
    "GET",
    "HEAD",
    "OPTIONS",
    "POST",
    "PUT",
    "DELETE",
    "PATCH"
];
function isHTTPMethod(maybeMethod) {
    return HTTP_METHODS.includes(maybeMethod);
} //# sourceMappingURL=http.js.map


/***/ }),

/***/ 7745:
/***/ ((__unused_webpack_module, exports, __webpack_require__) => {


Object.defineProperty(exports, "__esModule", ({
    value: true
}));
Object.defineProperty(exports, "NextURL", ({
    enumerable: true,
    get: function() {
        return NextURL;
    }
}));
const _detectdomainlocale = __webpack_require__(6961);
const _formatnextpathnameinfo = __webpack_require__(1220);
const _gethostname = __webpack_require__(4029);
const _getnextpathnameinfo = __webpack_require__(1439);
const REGEX_LOCALHOST_HOSTNAME = /(?!^https?:\/\/)(127(?:\.(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)){3}|::1|localhost)/;
function parseURL(url, base) {
    return new URL(String(url).replace(REGEX_LOCALHOST_HOSTNAME, "localhost"), base && String(base).replace(REGEX_LOCALHOST_HOSTNAME, "localhost"));
}
const Internal = Symbol("NextURLInternal");
class NextURL {
    constructor(input, baseOrOpts, opts){
        let base;
        let options;
        if (typeof baseOrOpts === "object" && "pathname" in baseOrOpts || typeof baseOrOpts === "string") {
            base = baseOrOpts;
            options = opts || {};
        } else {
            options = opts || baseOrOpts || {};
        }
        this[Internal] = {
            url: parseURL(input, base ?? options.base),
            options: options,
            basePath: ""
        };
        this.analyze();
    }
    analyze() {
        var _this_Internal_options_nextConfig, _this_Internal_options_nextConfig_i18n, _this_Internal_domainLocale, _this_Internal_options_nextConfig1, _this_Internal_options_nextConfig_i18n1;
        const info = (0, _getnextpathnameinfo.getNextPathnameInfo)(this[Internal].url.pathname, {
            nextConfig: this[Internal].options.nextConfig,
            parseData: !undefined,
            i18nProvider: this[Internal].options.i18nProvider
        });
        const hostname = (0, _gethostname.getHostname)(this[Internal].url, this[Internal].options.headers);
        this[Internal].domainLocale = this[Internal].options.i18nProvider ? this[Internal].options.i18nProvider.detectDomainLocale(hostname) : (0, _detectdomainlocale.detectDomainLocale)((_this_Internal_options_nextConfig = this[Internal].options.nextConfig) == null ? void 0 : (_this_Internal_options_nextConfig_i18n = _this_Internal_options_nextConfig.i18n) == null ? void 0 : _this_Internal_options_nextConfig_i18n.domains, hostname);
        const defaultLocale = ((_this_Internal_domainLocale = this[Internal].domainLocale) == null ? void 0 : _this_Internal_domainLocale.defaultLocale) || ((_this_Internal_options_nextConfig1 = this[Internal].options.nextConfig) == null ? void 0 : (_this_Internal_options_nextConfig_i18n1 = _this_Internal_options_nextConfig1.i18n) == null ? void 0 : _this_Internal_options_nextConfig_i18n1.defaultLocale);
        this[Internal].url.pathname = info.pathname;
        this[Internal].defaultLocale = defaultLocale;
        this[Internal].basePath = info.basePath ?? "";
        this[Internal].buildId = info.buildId;
        this[Internal].locale = info.locale ?? defaultLocale;
        this[Internal].trailingSlash = info.trailingSlash;
    }
    formatPathname() {
        return (0, _formatnextpathnameinfo.formatNextPathnameInfo)({
            basePath: this[Internal].basePath,
            buildId: this[Internal].buildId,
            defaultLocale: !this[Internal].options.forceLocale ? this[Internal].defaultLocale : undefined,
            locale: this[Internal].locale,
            pathname: this[Internal].url.pathname,
            trailingSlash: this[Internal].trailingSlash
        });
    }
    formatSearch() {
        return this[Internal].url.search;
    }
    get buildId() {
        return this[Internal].buildId;
    }
    set buildId(buildId) {
        this[Internal].buildId = buildId;
    }
    get locale() {
        return this[Internal].locale ?? "";
    }
    set locale(locale) {
        var _this_Internal_options_nextConfig, _this_Internal_options_nextConfig_i18n;
        if (!this[Internal].locale || !((_this_Internal_options_nextConfig = this[Internal].options.nextConfig) == null ? void 0 : (_this_Internal_options_nextConfig_i18n = _this_Internal_options_nextConfig.i18n) == null ? void 0 : _this_Internal_options_nextConfig_i18n.locales.includes(locale))) {
            throw new TypeError(`The NextURL configuration includes no locale "${locale}"`);
        }
        this[Internal].locale = locale;
    }
    get defaultLocale() {
        return this[Internal].defaultLocale;
    }
    get domainLocale() {
        return this[Internal].domainLocale;
    }
    get searchParams() {
        return this[Internal].url.searchParams;
    }
    get host() {
        return this[Internal].url.host;
    }
    set host(value) {
        this[Internal].url.host = value;
    }
    get hostname() {
        return this[Internal].url.hostname;
    }
    set hostname(value) {
        this[Internal].url.hostname = value;
    }
    get port() {
        return this[Internal].url.port;
    }
    set port(value) {
        this[Internal].url.port = value;
    }
    get protocol() {
        return this[Internal].url.protocol;
    }
    set protocol(value) {
        this[Internal].url.protocol = value;
    }
    get href() {
        const pathname = this.formatPathname();
        const search = this.formatSearch();
        return `${this.protocol}//${this.host}${pathname}${search}${this.hash}`;
    }
    set href(url) {
        this[Internal].url = parseURL(url);
        this.analyze();
    }
    get origin() {
        return this[Internal].url.origin;
    }
    get pathname() {
        return this[Internal].url.pathname;
    }
    set pathname(value) {
        this[Internal].url.pathname = value;
    }
    get hash() {
        return this[Internal].url.hash;
    }
    set hash(value) {
        this[Internal].url.hash = value;
    }
    get search() {
        return this[Internal].url.search;
    }
    set search(value) {
        this[Internal].url.search = value;
    }
    get password() {
        return this[Internal].url.password;
    }
    set password(value) {
        this[Internal].url.password = value;
    }
    get username() {
        return this[Internal].url.username;
    }
    set username(value) {
        this[Internal].url.username = value;
    }
    get basePath() {
        return this[Internal].basePath;
    }
    set basePath(value) {
        this[Internal].basePath = value.startsWith("/") ? value : `/${value}`;
    }
    toString() {
        return this.href;
    }
    toJSON() {
        return this.href;
    }
    [Symbol.for("edge-runtime.inspect.custom")]() {
        return {
            href: this.href,
            origin: this.origin,
            protocol: this.protocol,
            username: this.username,
            password: this.password,
            host: this.host,
            hostname: this.hostname,
            port: this.port,
            pathname: this.pathname,
            search: this.search,
            searchParams: this.searchParams,
            hash: this.hash
        };
    }
    clone() {
        return new NextURL(String(this), this[Internal].options);
    }
} //# sourceMappingURL=next-url.js.map


/***/ }),

/***/ 6877:
/***/ ((__unused_webpack_module, exports, __webpack_require__) => {


Object.defineProperty(exports, "__esModule", ({
    value: true
}));
0 && (0);
function _export(target, all) {
    for(var name in all)Object.defineProperty(target, name, {
        enumerable: true,
        get: all[name]
    });
}
_export(exports, {
    ReadonlyHeadersError: function() {
        return ReadonlyHeadersError;
    },
    HeadersAdapter: function() {
        return HeadersAdapter;
    }
});
const _reflect = __webpack_require__(7892);
class ReadonlyHeadersError extends Error {
    constructor(){
        super("Headers cannot be modified. Read more: https://nextjs.org/docs/app/api-reference/functions/headers");
    }
    static callable() {
        throw new ReadonlyHeadersError();
    }
}
class HeadersAdapter extends Headers {
    constructor(headers){
        // We've already overridden the methods that would be called, so we're just
        // calling the super constructor to ensure that the instanceof check works.
        super();
        this.headers = new Proxy(headers, {
            get (target, prop, receiver) {
                // Because this is just an object, we expect that all "get" operations
                // are for properties. If it's a "get" for a symbol, we'll just return
                // the symbol.
                if (typeof prop === "symbol") {
                    return _reflect.ReflectAdapter.get(target, prop, receiver);
                }
                const lowercased = prop.toLowerCase();
                // Let's find the original casing of the key. This assumes that there is
                // no mixed case keys (e.g. "Content-Type" and "content-type") in the
                // headers object.
                const original = Object.keys(headers).find((o)=>o.toLowerCase() === lowercased);
                // If the original casing doesn't exist, return undefined.
                if (typeof original === "undefined") return;
                // If the original casing exists, return the value.
                return _reflect.ReflectAdapter.get(target, original, receiver);
            },
            set (target, prop, value, receiver) {
                if (typeof prop === "symbol") {
                    return _reflect.ReflectAdapter.set(target, prop, value, receiver);
                }
                const lowercased = prop.toLowerCase();
                // Let's find the original casing of the key. This assumes that there is
                // no mixed case keys (e.g. "Content-Type" and "content-type") in the
                // headers object.
                const original = Object.keys(headers).find((o)=>o.toLowerCase() === lowercased);
                // If the original casing doesn't exist, use the prop as the key.
                return _reflect.ReflectAdapter.set(target, original ?? prop, value, receiver);
            },
            has (target, prop) {
                if (typeof prop === "symbol") return _reflect.ReflectAdapter.has(target, prop);
                const lowercased = prop.toLowerCase();
                // Let's find the original casing of the key. This assumes that there is
                // no mixed case keys (e.g. "Content-Type" and "content-type") in the
                // headers object.
                const original = Object.keys(headers).find((o)=>o.toLowerCase() === lowercased);
                // If the original casing doesn't exist, return false.
                if (typeof original === "undefined") return false;
                // If the original casing exists, return true.
                return _reflect.ReflectAdapter.has(target, original);
            },
            deleteProperty (target, prop) {
                if (typeof prop === "symbol") return _reflect.ReflectAdapter.deleteProperty(target, prop);
                const lowercased = prop.toLowerCase();
                // Let's find the original casing of the key. This assumes that there is
                // no mixed case keys (e.g. "Content-Type" and "content-type") in the
                // headers object.
                const original = Object.keys(headers).find((o)=>o.toLowerCase() === lowercased);
                // If the original casing doesn't exist, return true.
                if (typeof original === "undefined") return true;
                // If the original casing exists, delete the property.
                return _reflect.ReflectAdapter.deleteProperty(target, original);
            }
        });
    }
    /**
   * Seals a Headers instance to prevent modification by throwing an error when
   * any mutating method is called.
   */ static seal(headers) {
        return new Proxy(headers, {
            get (target, prop, receiver) {
                switch(prop){
                    case "append":
                    case "delete":
                    case "set":
                        return ReadonlyHeadersError.callable;
                    default:
                        return _reflect.ReflectAdapter.get(target, prop, receiver);
                }
            }
        });
    }
    /**
   * Merges a header value into a string. This stores multiple values as an
   * array, so we need to merge them into a string.
   *
   * @param value a header value
   * @returns a merged header value (a string)
   */ merge(value) {
        if (Array.isArray(value)) return value.join(", ");
        return value;
    }
    /**
   * Creates a Headers instance from a plain object or a Headers instance.
   *
   * @param headers a plain object or a Headers instance
   * @returns a headers instance
   */ static from(headers) {
        if (headers instanceof Headers) return headers;
        return new HeadersAdapter(headers);
    }
    append(name, value) {
        const existing = this.headers[name];
        if (typeof existing === "string") {
            this.headers[name] = [
                existing,
                value
            ];
        } else if (Array.isArray(existing)) {
            existing.push(value);
        } else {
            this.headers[name] = value;
        }
    }
    delete(name) {
        delete this.headers[name];
    }
    get(name) {
        const value = this.headers[name];
        if (typeof value !== "undefined") return this.merge(value);
        return null;
    }
    has(name) {
        return typeof this.headers[name] !== "undefined";
    }
    set(name, value) {
        this.headers[name] = value;
    }
    forEach(callbackfn, thisArg) {
        for (const [name, value] of this.entries()){
            callbackfn.call(thisArg, value, name, this);
        }
    }
    *entries() {
        for (const key of Object.keys(this.headers)){
            const name = key.toLowerCase();
            // We assert here that this is a string because we got it from the
            // Object.keys() call above.
            const value = this.get(name);
            yield [
                name,
                value
            ];
        }
    }
    *keys() {
        for (const key of Object.keys(this.headers)){
            const name = key.toLowerCase();
            yield name;
        }
    }
    *values() {
        for (const key of Object.keys(this.headers)){
            // We assert here that this is a string because we got it from the
            // Object.keys() call above.
            const value = this.get(key);
            yield value;
        }
    }
    [Symbol.iterator]() {
        return this.entries();
    }
} //# sourceMappingURL=headers.js.map


/***/ }),

/***/ 7892:
/***/ ((__unused_webpack_module, exports) => {


Object.defineProperty(exports, "__esModule", ({
    value: true
}));
Object.defineProperty(exports, "ReflectAdapter", ({
    enumerable: true,
    get: function() {
        return ReflectAdapter;
    }
}));
class ReflectAdapter {
    static get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (typeof value === "function") {
            return value.bind(target);
        }
        return value;
    }
    static set(target, prop, value, receiver) {
        return Reflect.set(target, prop, value, receiver);
    }
    static has(target, prop) {
        return Reflect.has(target, prop);
    }
    static deleteProperty(target, prop) {
        return Reflect.deleteProperty(target, prop);
    }
} //# sourceMappingURL=reflect.js.map


/***/ }),

/***/ 4895:
/***/ ((__unused_webpack_module, exports, __webpack_require__) => {


Object.defineProperty(exports, "__esModule", ({
    value: true
}));
0 && (0);
function _export(target, all) {
    for(var name in all)Object.defineProperty(target, name, {
        enumerable: true,
        get: all[name]
    });
}
_export(exports, {
    ReadonlyRequestCookiesError: function() {
        return ReadonlyRequestCookiesError;
    },
    RequestCookiesAdapter: function() {
        return RequestCookiesAdapter;
    },
    getModifiedCookieValues: function() {
        return getModifiedCookieValues;
    },
    appendMutableCookies: function() {
        return appendMutableCookies;
    },
    MutableRequestCookiesAdapter: function() {
        return MutableRequestCookiesAdapter;
    }
});
const _cookies = __webpack_require__(6454);
const _reflect = __webpack_require__(7892);
class ReadonlyRequestCookiesError extends Error {
    constructor(){
        super("Cookies can only be modified in a Server Action or Route Handler. Read more: https://nextjs.org/docs/app/api-reference/functions/cookies#cookiessetname-value-options");
    }
    static callable() {
        throw new ReadonlyRequestCookiesError();
    }
}
class RequestCookiesAdapter {
    static seal(cookies) {
        return new Proxy(cookies, {
            get (target, prop, receiver) {
                switch(prop){
                    case "clear":
                    case "delete":
                    case "set":
                        return ReadonlyRequestCookiesError.callable;
                    default:
                        return _reflect.ReflectAdapter.get(target, prop, receiver);
                }
            }
        });
    }
}
const SYMBOL_MODIFY_COOKIE_VALUES = Symbol.for("next.mutated.cookies");
function getModifiedCookieValues(cookies) {
    const modified = cookies[SYMBOL_MODIFY_COOKIE_VALUES];
    if (!modified || !Array.isArray(modified) || modified.length === 0) {
        return [];
    }
    return modified;
}
function appendMutableCookies(headers, mutableCookies) {
    const modifiedCookieValues = getModifiedCookieValues(mutableCookies);
    if (modifiedCookieValues.length === 0) {
        return false;
    }
    // Return a new response that extends the response with
    // the modified cookies as fallbacks. `res`' cookies
    // will still take precedence.
    const resCookies = new _cookies.ResponseCookies(headers);
    const returnedCookies = resCookies.getAll();
    // Set the modified cookies as fallbacks.
    for (const cookie of modifiedCookieValues){
        resCookies.set(cookie);
    }
    // Set the original cookies as the final values.
    for (const cookie of returnedCookies){
        resCookies.set(cookie);
    }
    return true;
}
class MutableRequestCookiesAdapter {
    static wrap(cookies, res) {
        const responseCookes = new _cookies.ResponseCookies(new Headers());
        for (const cookie of cookies.getAll()){
            responseCookes.set(cookie);
        }
        let modifiedValues = [];
        const modifiedCookies = new Set();
        const updateResponseCookies = ()=>{
            var _fetch___nextGetStaticStore;
            // TODO-APP: change method of getting staticGenerationAsyncStore
            const staticGenerationAsyncStore = fetch.__nextGetStaticStore == null ? void 0 : (_fetch___nextGetStaticStore = fetch.__nextGetStaticStore()) == null ? void 0 : _fetch___nextGetStaticStore.getStore();
            if (staticGenerationAsyncStore) {
                staticGenerationAsyncStore.pathWasRevalidated = true;
            }
            const allCookies = responseCookes.getAll();
            modifiedValues = allCookies.filter((c)=>modifiedCookies.has(c.name));
            if (res) {
                const serializedCookies = [];
                for (const cookie of modifiedValues){
                    const tempCookies = new _cookies.ResponseCookies(new Headers());
                    tempCookies.set(cookie);
                    serializedCookies.push(tempCookies.toString());
                }
                res.setHeader("Set-Cookie", serializedCookies);
            }
        };
        return new Proxy(responseCookes, {
            get (target, prop, receiver) {
                switch(prop){
                    // A special symbol to get the modified cookie values
                    case SYMBOL_MODIFY_COOKIE_VALUES:
                        return modifiedValues;
                    // TODO: Throw error if trying to set a cookie after the response
                    // headers have been set.
                    case "delete":
                        return function(...args) {
                            modifiedCookies.add(typeof args[0] === "string" ? args[0] : args[0].name);
                            try {
                                target.delete(...args);
                            } finally{
                                updateResponseCookies();
                            }
                        };
                    case "set":
                        return function(...args) {
                            modifiedCookies.add(typeof args[0] === "string" ? args[0] : args[0].name);
                            try {
                                return target.set(...args);
                            } finally{
                                updateResponseCookies();
                            }
                        };
                    default:
                        return _reflect.ReflectAdapter.get(target, prop, receiver);
                }
            }
        });
    }
} //# sourceMappingURL=request-cookies.js.map


/***/ }),

/***/ 6454:
/***/ ((__unused_webpack_module, exports, __webpack_require__) => {


Object.defineProperty(exports, "__esModule", ({
    value: true
}));
0 && (0);
function _export(target, all) {
    for(var name in all)Object.defineProperty(target, name, {
        enumerable: true,
        get: all[name]
    });
}
_export(exports, {
    RequestCookies: function() {
        return _cookies.RequestCookies;
    },
    ResponseCookies: function() {
        return _cookies.ResponseCookies;
    }
});
const _cookies = __webpack_require__(7783); //# sourceMappingURL=cookies.js.map


/***/ }),

/***/ 2044:
/***/ ((__unused_webpack_module, exports, __webpack_require__) => {


Object.defineProperty(exports, "__esModule", ({
    value: true
}));
Object.defineProperty(exports, "NextResponse", ({
    enumerable: true,
    get: function() {
        return NextResponse;
    }
}));
const _nexturl = __webpack_require__(7745);
const _utils = __webpack_require__(2771);
const _cookies = __webpack_require__(6454);
const INTERNALS = Symbol("internal response");
const REDIRECTS = new Set([
    301,
    302,
    303,
    307,
    308
]);
function handleMiddlewareField(init, headers) {
    var _init_request;
    if (init == null ? void 0 : (_init_request = init.request) == null ? void 0 : _init_request.headers) {
        if (!(init.request.headers instanceof Headers)) {
            throw new Error("request.headers must be an instance of Headers");
        }
        const keys = [];
        for (const [key, value] of init.request.headers){
            headers.set("x-middleware-request-" + key, value);
            keys.push(key);
        }
        headers.set("x-middleware-override-headers", keys.join(","));
    }
}
class NextResponse extends Response {
    constructor(body, init = {}){
        super(body, init);
        this[INTERNALS] = {
            cookies: new _cookies.ResponseCookies(this.headers),
            url: init.url ? new _nexturl.NextURL(init.url, {
                headers: (0, _utils.toNodeOutgoingHttpHeaders)(this.headers),
                nextConfig: init.nextConfig
            }) : undefined
        };
    }
    [Symbol.for("edge-runtime.inspect.custom")]() {
        return {
            cookies: this.cookies,
            url: this.url,
            // rest of props come from Response
            body: this.body,
            bodyUsed: this.bodyUsed,
            headers: Object.fromEntries(this.headers),
            ok: this.ok,
            redirected: this.redirected,
            status: this.status,
            statusText: this.statusText,
            type: this.type
        };
    }
    get cookies() {
        return this[INTERNALS].cookies;
    }
    static json(body, init) {
        // @ts-expect-error This is not in lib/dom right now, and we can't augment it.
        const response = Response.json(body, init);
        return new NextResponse(response.body, response);
    }
    static redirect(url, init) {
        const status = typeof init === "number" ? init : (init == null ? void 0 : init.status) ?? 307;
        if (!REDIRECTS.has(status)) {
            throw new RangeError('Failed to execute "redirect" on "response": Invalid status code');
        }
        const initObj = typeof init === "object" ? init : {};
        const headers = new Headers(initObj == null ? void 0 : initObj.headers);
        headers.set("Location", (0, _utils.validateURL)(url));
        return new NextResponse(null, {
            ...initObj,
            headers,
            status
        });
    }
    static rewrite(destination, init) {
        const headers = new Headers(init == null ? void 0 : init.headers);
        headers.set("x-middleware-rewrite", (0, _utils.validateURL)(destination));
        handleMiddlewareField(init, headers);
        return new NextResponse(null, {
            ...init,
            headers
        });
    }
    static next(init) {
        const headers = new Headers(init == null ? void 0 : init.headers);
        headers.set("x-middleware-next", "1");
        handleMiddlewareField(init, headers);
        return new NextResponse(null, {
            ...init,
            headers
        });
    }
} //# sourceMappingURL=response.js.map


/***/ }),

/***/ 2771:
/***/ ((__unused_webpack_module, exports) => {


Object.defineProperty(exports, "__esModule", ({
    value: true
}));
0 && (0);
function _export(target, all) {
    for(var name in all)Object.defineProperty(target, name, {
        enumerable: true,
        get: all[name]
    });
}
_export(exports, {
    fromNodeOutgoingHttpHeaders: function() {
        return fromNodeOutgoingHttpHeaders;
    },
    splitCookiesString: function() {
        return splitCookiesString;
    },
    toNodeOutgoingHttpHeaders: function() {
        return toNodeOutgoingHttpHeaders;
    },
    validateURL: function() {
        return validateURL;
    }
});
function fromNodeOutgoingHttpHeaders(nodeHeaders) {
    const headers = new Headers();
    for (let [key, value] of Object.entries(nodeHeaders)){
        const values = Array.isArray(value) ? value : [
            value
        ];
        for (let v of values){
            if (typeof v === "undefined") continue;
            if (typeof v === "number") {
                v = v.toString();
            }
            headers.append(key, v);
        }
    }
    return headers;
}
function splitCookiesString(cookiesString) {
    var cookiesStrings = [];
    var pos = 0;
    var start;
    var ch;
    var lastComma;
    var nextStart;
    var cookiesSeparatorFound;
    function skipWhitespace() {
        while(pos < cookiesString.length && /\s/.test(cookiesString.charAt(pos))){
            pos += 1;
        }
        return pos < cookiesString.length;
    }
    function notSpecialChar() {
        ch = cookiesString.charAt(pos);
        return ch !== "=" && ch !== ";" && ch !== ",";
    }
    while(pos < cookiesString.length){
        start = pos;
        cookiesSeparatorFound = false;
        while(skipWhitespace()){
            ch = cookiesString.charAt(pos);
            if (ch === ",") {
                // ',' is a cookie separator if we have later first '=', not ';' or ','
                lastComma = pos;
                pos += 1;
                skipWhitespace();
                nextStart = pos;
                while(pos < cookiesString.length && notSpecialChar()){
                    pos += 1;
                }
                // currently special character
                if (pos < cookiesString.length && cookiesString.charAt(pos) === "=") {
                    // we found cookies separator
                    cookiesSeparatorFound = true;
                    // pos is inside the next cookie, so back up and return it.
                    pos = nextStart;
                    cookiesStrings.push(cookiesString.substring(start, lastComma));
                    start = pos;
                } else {
                    // in param ',' or param separator ';',
                    // we continue from that comma
                    pos = lastComma + 1;
                }
            } else {
                pos += 1;
            }
        }
        if (!cookiesSeparatorFound || pos >= cookiesString.length) {
            cookiesStrings.push(cookiesString.substring(start, cookiesString.length));
        }
    }
    return cookiesStrings;
}
function toNodeOutgoingHttpHeaders(headers) {
    const nodeHeaders = {};
    const cookies = [];
    if (headers) {
        for (const [key, value] of headers.entries()){
            if (key.toLowerCase() === "set-cookie") {
                // We may have gotten a comma joined string of cookies, or multiple
                // set-cookie headers. We need to merge them into one header array
                // to represent all the cookies.
                cookies.push(...splitCookiesString(value));
                nodeHeaders[key] = cookies.length === 1 ? cookies[0] : cookies;
            } else {
                nodeHeaders[key] = value;
            }
        }
    }
    return nodeHeaders;
}
function validateURL(url) {
    try {
        return String(new URL(String(url)));
    } catch (error) {
        throw new Error(`URL is malformed "${String(url)}". Please use only absolute URLs - https://nextjs.org/docs/messages/middleware-relative-urls`, {
            cause: error
        });
    }
} //# sourceMappingURL=utils.js.map


/***/ }),

/***/ 4029:
/***/ ((__unused_webpack_module, exports) => {


Object.defineProperty(exports, "__esModule", ({
    value: true
}));
Object.defineProperty(exports, "getHostname", ({
    enumerable: true,
    get: function() {
        return getHostname;
    }
}));
function getHostname(parsed, headers) {
    // Get the hostname from the headers if it exists, otherwise use the parsed
    // hostname.
    let hostname;
    if ((headers == null ? void 0 : headers.host) && !Array.isArray(headers.host)) {
        hostname = headers.host.toString().split(":")[0];
    } else if (parsed.hostname) {
        hostname = parsed.hostname;
    } else return;
    return hostname.toLowerCase();
} //# sourceMappingURL=get-hostname.js.map


/***/ }),

/***/ 6961:
/***/ ((__unused_webpack_module, exports) => {


Object.defineProperty(exports, "__esModule", ({
    value: true
}));
Object.defineProperty(exports, "detectDomainLocale", ({
    enumerable: true,
    get: function() {
        return detectDomainLocale;
    }
}));
function detectDomainLocale(domainItems, hostname, detectedLocale) {
    if (!domainItems) return;
    if (detectedLocale) {
        detectedLocale = detectedLocale.toLowerCase();
    }
    for (const item of domainItems){
        var _item_domain, _item_locales;
        // remove port if present
        const domainHostname = (_item_domain = item.domain) == null ? void 0 : _item_domain.split(":")[0].toLowerCase();
        if (hostname === domainHostname || detectedLocale === item.defaultLocale.toLowerCase() || ((_item_locales = item.locales) == null ? void 0 : _item_locales.some((locale)=>locale.toLowerCase() === detectedLocale))) {
            return item;
        }
    }
} //# sourceMappingURL=detect-domain-locale.js.map


/***/ }),

/***/ 8735:
/***/ ((__unused_webpack_module, exports) => {


Object.defineProperty(exports, "__esModule", ({
    value: true
}));
Object.defineProperty(exports, "normalizeLocalePath", ({
    enumerable: true,
    get: function() {
        return normalizeLocalePath;
    }
}));
function normalizeLocalePath(pathname, locales) {
    let detectedLocale;
    // first item will be empty string from splitting at first char
    const pathnameParts = pathname.split("/");
    (locales || []).some((locale)=>{
        if (pathnameParts[1] && pathnameParts[1].toLowerCase() === locale.toLowerCase()) {
            detectedLocale = locale;
            pathnameParts.splice(1, 1);
            pathname = pathnameParts.join("/") || "/";
            return true;
        }
        return false;
    });
    return {
        pathname,
        detectedLocale
    };
} //# sourceMappingURL=normalize-locale-path.js.map


/***/ }),

/***/ 7606:
/***/ ((__unused_webpack_module, exports, __webpack_require__) => {


Object.defineProperty(exports, "__esModule", ({
    value: true
}));
Object.defineProperty(exports, "addLocale", ({
    enumerable: true,
    get: function() {
        return addLocale;
    }
}));
const _addpathprefix = __webpack_require__(5062);
const _pathhasprefix = __webpack_require__(5418);
function addLocale(path, locale, defaultLocale, ignorePrefix) {
    // If no locale was given or the locale is the default locale, we don't need
    // to prefix the path.
    if (!locale || locale === defaultLocale) return path;
    const lower = path.toLowerCase();
    // If the path is an API path or the path already has the locale prefix, we
    // don't need to prefix the path.
    if (!ignorePrefix) {
        if ((0, _pathhasprefix.pathHasPrefix)(lower, "/api")) return path;
        if ((0, _pathhasprefix.pathHasPrefix)(lower, "/" + locale.toLowerCase())) return path;
    }
    // Add the locale prefix to the path.
    return (0, _addpathprefix.addPathPrefix)(path, "/" + locale);
} //# sourceMappingURL=add-locale.js.map


/***/ }),

/***/ 5062:
/***/ ((__unused_webpack_module, exports, __webpack_require__) => {


Object.defineProperty(exports, "__esModule", ({
    value: true
}));
Object.defineProperty(exports, "addPathPrefix", ({
    enumerable: true,
    get: function() {
        return addPathPrefix;
    }
}));
const _parsepath = __webpack_require__(9882);
function addPathPrefix(path, prefix) {
    if (!path.startsWith("/") || !prefix) {
        return path;
    }
    const { pathname, query, hash } = (0, _parsepath.parsePath)(path);
    return "" + prefix + pathname + query + hash;
} //# sourceMappingURL=add-path-prefix.js.map


/***/ }),

/***/ 5337:
/***/ ((__unused_webpack_module, exports, __webpack_require__) => {


Object.defineProperty(exports, "__esModule", ({
    value: true
}));
Object.defineProperty(exports, "addPathSuffix", ({
    enumerable: true,
    get: function() {
        return addPathSuffix;
    }
}));
const _parsepath = __webpack_require__(9882);
function addPathSuffix(path, suffix) {
    if (!path.startsWith("/") || !suffix) {
        return path;
    }
    const { pathname, query, hash } = (0, _parsepath.parsePath)(path);
    return "" + pathname + suffix + query + hash;
} //# sourceMappingURL=add-path-suffix.js.map


/***/ }),

/***/ 1220:
/***/ ((__unused_webpack_module, exports, __webpack_require__) => {


Object.defineProperty(exports, "__esModule", ({
    value: true
}));
Object.defineProperty(exports, "formatNextPathnameInfo", ({
    enumerable: true,
    get: function() {
        return formatNextPathnameInfo;
    }
}));
const _removetrailingslash = __webpack_require__(6925);
const _addpathprefix = __webpack_require__(5062);
const _addpathsuffix = __webpack_require__(5337);
const _addlocale = __webpack_require__(7606);
function formatNextPathnameInfo(info) {
    let pathname = (0, _addlocale.addLocale)(info.pathname, info.locale, info.buildId ? undefined : info.defaultLocale, info.ignorePrefix);
    if (info.buildId || !info.trailingSlash) {
        pathname = (0, _removetrailingslash.removeTrailingSlash)(pathname);
    }
    if (info.buildId) {
        pathname = (0, _addpathsuffix.addPathSuffix)((0, _addpathprefix.addPathPrefix)(pathname, "/_next/data/" + info.buildId), info.pathname === "/" ? "index.json" : ".json");
    }
    pathname = (0, _addpathprefix.addPathPrefix)(pathname, info.basePath);
    return !info.buildId && info.trailingSlash ? !pathname.endsWith("/") ? (0, _addpathsuffix.addPathSuffix)(pathname, "/") : pathname : (0, _removetrailingslash.removeTrailingSlash)(pathname);
} //# sourceMappingURL=format-next-pathname-info.js.map


/***/ }),

/***/ 1439:
/***/ ((__unused_webpack_module, exports, __webpack_require__) => {


Object.defineProperty(exports, "__esModule", ({
    value: true
}));
Object.defineProperty(exports, "getNextPathnameInfo", ({
    enumerable: true,
    get: function() {
        return getNextPathnameInfo;
    }
}));
const _normalizelocalepath = __webpack_require__(8735);
const _removepathprefix = __webpack_require__(9646);
const _pathhasprefix = __webpack_require__(5418);
function getNextPathnameInfo(pathname, options) {
    var _options_nextConfig;
    const { basePath, i18n, trailingSlash } = (_options_nextConfig = options.nextConfig) != null ? _options_nextConfig : {};
    const info = {
        pathname: pathname,
        trailingSlash: pathname !== "/" ? pathname.endsWith("/") : trailingSlash
    };
    if (basePath && (0, _pathhasprefix.pathHasPrefix)(info.pathname, basePath)) {
        info.pathname = (0, _removepathprefix.removePathPrefix)(info.pathname, basePath);
        info.basePath = basePath;
    }
    if (options.parseData === true && info.pathname.startsWith("/_next/data/") && info.pathname.endsWith(".json")) {
        const paths = info.pathname.replace(/^\/_next\/data\//, "").replace(/\.json$/, "").split("/");
        const buildId = paths[0];
        info.pathname = paths[1] !== "index" ? "/" + paths.slice(1).join("/") : "/";
        info.buildId = buildId;
    }
    // If provided, use the locale route normalizer to detect the locale instead
    // of the function below.
    if (options.i18nProvider) {
        const result = options.i18nProvider.analyze(info.pathname);
        info.locale = result.detectedLocale;
        var _result_pathname;
        info.pathname = (_result_pathname = result.pathname) != null ? _result_pathname : info.pathname;
    } else if (i18n) {
        const pathLocale = (0, _normalizelocalepath.normalizeLocalePath)(info.pathname, i18n.locales);
        info.locale = pathLocale.detectedLocale;
        var _pathLocale_pathname;
        info.pathname = (_pathLocale_pathname = pathLocale.pathname) != null ? _pathLocale_pathname : info.pathname;
    }
    return info;
} //# sourceMappingURL=get-next-pathname-info.js.map


/***/ }),

/***/ 9882:
/***/ ((__unused_webpack_module, exports) => {

/**
 * Given a path this function will find the pathname, query and hash and return
 * them. This is useful to parse full paths on the client side.
 * @param path A path to parse e.g. /foo/bar?id=1#hash
 */ 
Object.defineProperty(exports, "__esModule", ({
    value: true
}));
Object.defineProperty(exports, "parsePath", ({
    enumerable: true,
    get: function() {
        return parsePath;
    }
}));
function parsePath(path) {
    const hashIndex = path.indexOf("#");
    const queryIndex = path.indexOf("?");
    const hasQuery = queryIndex > -1 && (hashIndex < 0 || queryIndex < hashIndex);
    if (hasQuery || hashIndex > -1) {
        return {
            pathname: path.substring(0, hasQuery ? queryIndex : hashIndex),
            query: hasQuery ? path.substring(queryIndex, hashIndex > -1 ? hashIndex : undefined) : "",
            hash: hashIndex > -1 ? path.slice(hashIndex) : ""
        };
    }
    return {
        pathname: path,
        query: "",
        hash: ""
    };
} //# sourceMappingURL=parse-path.js.map


/***/ }),

/***/ 5418:
/***/ ((__unused_webpack_module, exports, __webpack_require__) => {


Object.defineProperty(exports, "__esModule", ({
    value: true
}));
Object.defineProperty(exports, "pathHasPrefix", ({
    enumerable: true,
    get: function() {
        return pathHasPrefix;
    }
}));
const _parsepath = __webpack_require__(9882);
function pathHasPrefix(path, prefix) {
    if (typeof path !== "string") {
        return false;
    }
    const { pathname } = (0, _parsepath.parsePath)(path);
    return pathname === prefix || pathname.startsWith(prefix + "/");
} //# sourceMappingURL=path-has-prefix.js.map


/***/ }),

/***/ 9646:
/***/ ((__unused_webpack_module, exports, __webpack_require__) => {


Object.defineProperty(exports, "__esModule", ({
    value: true
}));
Object.defineProperty(exports, "removePathPrefix", ({
    enumerable: true,
    get: function() {
        return removePathPrefix;
    }
}));
const _pathhasprefix = __webpack_require__(5418);
function removePathPrefix(path, prefix) {
    // If the path doesn't start with the prefix we can return it as is. This
    // protects us from situations where the prefix is a substring of the path
    // prefix such as:
    //
    // For prefix: /blog
    //
    //   /blog -> true
    //   /blog/ -> true
    //   /blog/1 -> true
    //   /blogging -> false
    //   /blogging/ -> false
    //   /blogging/1 -> false
    if (!(0, _pathhasprefix.pathHasPrefix)(path, prefix)) {
        return path;
    }
    // Remove the prefix from the path via slicing.
    const withoutPrefix = path.slice(prefix.length);
    // If the path without the prefix starts with a `/` we can return it as is.
    if (withoutPrefix.startsWith("/")) {
        return withoutPrefix;
    }
    // If the path without the prefix doesn't start with a `/` we need to add it
    // back to the path to make sure it's a valid path.
    return "/" + withoutPrefix;
} //# sourceMappingURL=remove-path-prefix.js.map


/***/ }),

/***/ 6925:
/***/ ((__unused_webpack_module, exports) => {

/**
 * Removes the trailing slash for a given route or page path. Preserves the
 * root page. Examples:
 *   - `/foo/bar/` -> `/foo/bar`
 *   - `/foo/bar` -> `/foo/bar`
 *   - `/` -> `/`
 */ 
Object.defineProperty(exports, "__esModule", ({
    value: true
}));
Object.defineProperty(exports, "removeTrailingSlash", ({
    enumerable: true,
    get: function() {
        return removeTrailingSlash;
    }
}));
function removeTrailingSlash(route) {
    return route.replace(/\/$/, "") || "/";
} //# sourceMappingURL=remove-trailing-slash.js.map


/***/ }),

/***/ 4604:
/***/ ((module, __unused_webpack_exports, __webpack_require__) => {


module.exports = __webpack_require__(5117);


/***/ }),

/***/ 4252:
/***/ ((__unused_webpack___webpack_module__, __webpack_exports__, __webpack_require__) => {


// EXPORTS
__webpack_require__.d(__webpack_exports__, {
  s: () => (/* binding */ Redis)
});

;// CONCATENATED MODULE: ./node_modules/.pnpm/@upstash+redis@1.21.0/node_modules/@upstash/redis/esm/pkg/error.js
/**
 * Result of a bad request to upstash
 */ class UpstashError extends Error {
    constructor(message){
        super(message);
        this.name = "UpstashError";
    }
}

;// CONCATENATED MODULE: ./node_modules/.pnpm/@upstash+redis@1.21.0/node_modules/@upstash/redis/esm/pkg/util.js
function parseRecursive(obj) {
    const parsed = Array.isArray(obj) ? obj.map((o)=>{
        try {
            return parseRecursive(o);
        } catch  {
            return o;
        }
    }) : JSON.parse(obj);
    /**
     * Parsing very large numbers can result in MAX_SAFE_INTEGER
     * overflow. In that case we return the number as string instead.
     */ if (typeof parsed === "number" && parsed.toString() != obj) {
        return obj;
    }
    return parsed;
}
function parseResponse(result) {
    try {
        /**
         * Try to parse the response if possible
         */ return parseRecursive(result);
    } catch  {
        return result;
    }
}

;// CONCATENATED MODULE: ./node_modules/.pnpm/@upstash+redis@1.21.0/node_modules/@upstash/redis/esm/pkg/commands/command.js


const defaultSerializer = (c)=>{
    switch(typeof c){
        case "string":
        case "number":
        case "boolean":
            return c;
        default:
            return JSON.stringify(c);
    }
};
/**
 * Command offers default (de)serialization and the exec method to all commands.
 *
 * TData represents what the user will enter or receive,
 * TResult is the raw data returned from upstash, which may need to be transformed or parsed.
 */ class Command {
    /**
     * Create a new command instance.
     *
     * You can define a custom `deserialize` function. By default we try to deserialize as json.
     */ constructor(command, opts){
        Object.defineProperty(this, "command", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        Object.defineProperty(this, "serialize", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        Object.defineProperty(this, "deserialize", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        this.serialize = defaultSerializer;
        this.deserialize = typeof opts?.automaticDeserialization === "undefined" || opts.automaticDeserialization ? opts?.deserialize ?? parseResponse : (x)=>x;
        this.command = command.map((c)=>this.serialize(c));
    }
    /**
     * Execute the command using a client.
     */ async exec(client) {
        const { result, error } = await client.request({
            body: this.command
        });
        if (error) {
            throw new UpstashError(error);
        }
        if (typeof result === "undefined") {
            throw new Error("Request did not return a result");
        }
        return this.deserialize(result);
    }
}

;// CONCATENATED MODULE: ./node_modules/.pnpm/@upstash+redis@1.21.0/node_modules/@upstash/redis/esm/pkg/commands/append.js

/**
 * @see https://redis.io/commands/append
 */ class AppendCommand extends Command {
    constructor(cmd, opts){
        super([
            "append",
            ...cmd
        ], opts);
    }
}

;// CONCATENATED MODULE: ./node_modules/.pnpm/@upstash+redis@1.21.0/node_modules/@upstash/redis/esm/pkg/commands/bitcount.js

/**
 * @see https://redis.io/commands/bitcount
 */ class BitCountCommand extends Command {
    constructor([key, start, end], opts){
        const command = [
            "bitcount",
            key
        ];
        if (typeof start === "number") {
            command.push(start);
        }
        if (typeof end === "number") {
            command.push(end);
        }
        super(command, opts);
    }
}

;// CONCATENATED MODULE: ./node_modules/.pnpm/@upstash+redis@1.21.0/node_modules/@upstash/redis/esm/pkg/commands/bitop.js

/**
 * @see https://redis.io/commands/bitop
 */ class BitOpCommand extends Command {
    constructor(cmd, opts){
        super([
            "bitop",
            ...cmd
        ], opts);
    }
}

;// CONCATENATED MODULE: ./node_modules/.pnpm/@upstash+redis@1.21.0/node_modules/@upstash/redis/esm/pkg/commands/bitpos.js

/**
 * @see https://redis.io/commands/bitpos
 */ class BitPosCommand extends Command {
    constructor(cmd, opts){
        super([
            "bitpos",
            ...cmd
        ], opts);
    }
}

;// CONCATENATED MODULE: ./node_modules/.pnpm/@upstash+redis@1.21.0/node_modules/@upstash/redis/esm/pkg/commands/dbsize.js

/**
 * @see https://redis.io/commands/dbsize
 */ class DBSizeCommand extends Command {
    constructor(opts){
        super([
            "dbsize"
        ], opts);
    }
}

;// CONCATENATED MODULE: ./node_modules/.pnpm/@upstash+redis@1.21.0/node_modules/@upstash/redis/esm/pkg/commands/decr.js

/**
 * @see https://redis.io/commands/decr
 */ class DecrCommand extends Command {
    constructor(cmd, opts){
        super([
            "decr",
            ...cmd
        ], opts);
    }
}

;// CONCATENATED MODULE: ./node_modules/.pnpm/@upstash+redis@1.21.0/node_modules/@upstash/redis/esm/pkg/commands/decrby.js

/**
 * @see https://redis.io/commands/decrby
 */ class DecrByCommand extends Command {
    constructor(cmd, opts){
        super([
            "decrby",
            ...cmd
        ], opts);
    }
}

;// CONCATENATED MODULE: ./node_modules/.pnpm/@upstash+redis@1.21.0/node_modules/@upstash/redis/esm/pkg/commands/del.js

/**
 * @see https://redis.io/commands/del
 */ class DelCommand extends Command {
    constructor(cmd, opts){
        super([
            "del",
            ...cmd
        ], opts);
    }
}

;// CONCATENATED MODULE: ./node_modules/.pnpm/@upstash+redis@1.21.0/node_modules/@upstash/redis/esm/pkg/commands/echo.js

/**
 * @see https://redis.io/commands/echo
 */ class EchoCommand extends Command {
    constructor(cmd, opts){
        super([
            "echo",
            ...cmd
        ], opts);
    }
}

;// CONCATENATED MODULE: ./node_modules/.pnpm/@upstash+redis@1.21.0/node_modules/@upstash/redis/esm/pkg/commands/eval.js

/**
 * @see https://redis.io/commands/eval
 */ class EvalCommand extends Command {
    constructor([script, keys, args], opts){
        super([
            "eval",
            script,
            keys.length,
            ...keys,
            ...args ?? []
        ], opts);
    }
}

;// CONCATENATED MODULE: ./node_modules/.pnpm/@upstash+redis@1.21.0/node_modules/@upstash/redis/esm/pkg/commands/evalsha.js

/**
 * @see https://redis.io/commands/evalsha
 */ class EvalshaCommand extends Command {
    constructor([sha, keys, args], opts){
        super([
            "evalsha",
            sha,
            keys.length,
            ...keys,
            ...args ?? []
        ], opts);
    }
}

;// CONCATENATED MODULE: ./node_modules/.pnpm/@upstash+redis@1.21.0/node_modules/@upstash/redis/esm/pkg/commands/exists.js

/**
 * @see https://redis.io/commands/exists
 */ class ExistsCommand extends Command {
    constructor(cmd, opts){
        super([
            "exists",
            ...cmd
        ], opts);
    }
}

;// CONCATENATED MODULE: ./node_modules/.pnpm/@upstash+redis@1.21.0/node_modules/@upstash/redis/esm/pkg/commands/expire.js

/**
 * @see https://redis.io/commands/expire
 */ class ExpireCommand extends Command {
    constructor(cmd, opts){
        super([
            "expire",
            ...cmd
        ], opts);
    }
}

;// CONCATENATED MODULE: ./node_modules/.pnpm/@upstash+redis@1.21.0/node_modules/@upstash/redis/esm/pkg/commands/expireat.js

/**
 * @see https://redis.io/commands/expireat
 */ class ExpireAtCommand extends Command {
    constructor(cmd, opts){
        super([
            "expireat",
            ...cmd
        ], opts);
    }
}

;// CONCATENATED MODULE: ./node_modules/.pnpm/@upstash+redis@1.21.0/node_modules/@upstash/redis/esm/pkg/commands/flushall.js

/**
 * @see https://redis.io/commands/flushall
 */ class FlushAllCommand extends Command {
    constructor(args, opts){
        const command = [
            "flushall"
        ];
        if (args && args.length > 0 && args[0].async) {
            command.push("async");
        }
        super(command, opts);
    }
}

;// CONCATENATED MODULE: ./node_modules/.pnpm/@upstash+redis@1.21.0/node_modules/@upstash/redis/esm/pkg/commands/flushdb.js

/**
 * @see https://redis.io/commands/flushdb
 */ class FlushDBCommand extends Command {
    constructor([opts], cmdOpts){
        const command = [
            "flushdb"
        ];
        if (opts?.async) {
            command.push("async");
        }
        super(command, cmdOpts);
    }
}

;// CONCATENATED MODULE: ./node_modules/.pnpm/@upstash+redis@1.21.0/node_modules/@upstash/redis/esm/pkg/commands/get.js

/**
 * @see https://redis.io/commands/get
 */ class GetCommand extends Command {
    constructor(cmd, opts){
        super([
            "get",
            ...cmd
        ], opts);
    }
}

;// CONCATENATED MODULE: ./node_modules/.pnpm/@upstash+redis@1.21.0/node_modules/@upstash/redis/esm/pkg/commands/getbit.js

/**
 * @see https://redis.io/commands/getbit
 */ class GetBitCommand extends Command {
    constructor(cmd, opts){
        super([
            "getbit",
            ...cmd
        ], opts);
    }
}

;// CONCATENATED MODULE: ./node_modules/.pnpm/@upstash+redis@1.21.0/node_modules/@upstash/redis/esm/pkg/commands/getdel.js

/**
 * @see https://redis.io/commands/getdel
 */ class GetDelCommand extends Command {
    constructor(cmd, opts){
        super([
            "getdel",
            ...cmd
        ], opts);
    }
}

;// CONCATENATED MODULE: ./node_modules/.pnpm/@upstash+redis@1.21.0/node_modules/@upstash/redis/esm/pkg/commands/getrange.js

/**
 * @see https://redis.io/commands/getrange
 */ class GetRangeCommand extends Command {
    constructor(cmd, opts){
        super([
            "getrange",
            ...cmd
        ], opts);
    }
}

;// CONCATENATED MODULE: ./node_modules/.pnpm/@upstash+redis@1.21.0/node_modules/@upstash/redis/esm/pkg/commands/getset.js

/**
 * @see https://redis.io/commands/getset
 */ class GetSetCommand extends Command {
    constructor(cmd, opts){
        super([
            "getset",
            ...cmd
        ], opts);
    }
}

;// CONCATENATED MODULE: ./node_modules/.pnpm/@upstash+redis@1.21.0/node_modules/@upstash/redis/esm/pkg/commands/hdel.js

/**
 * @see https://redis.io/commands/hdel
 */ class HDelCommand extends Command {
    constructor(cmd, opts){
        super([
            "hdel",
            ...cmd
        ], opts);
    }
}

;// CONCATENATED MODULE: ./node_modules/.pnpm/@upstash+redis@1.21.0/node_modules/@upstash/redis/esm/pkg/commands/hexists.js

/**
 * @see https://redis.io/commands/hexists
 */ class HExistsCommand extends Command {
    constructor(cmd, opts){
        super([
            "hexists",
            ...cmd
        ], opts);
    }
}

;// CONCATENATED MODULE: ./node_modules/.pnpm/@upstash+redis@1.21.0/node_modules/@upstash/redis/esm/pkg/commands/hget.js

/**
 * @see https://redis.io/commands/hget
 */ class HGetCommand extends Command {
    constructor(cmd, opts){
        super([
            "hget",
            ...cmd
        ], opts);
    }
}

;// CONCATENATED MODULE: ./node_modules/.pnpm/@upstash+redis@1.21.0/node_modules/@upstash/redis/esm/pkg/commands/hgetall.js

function deserialize(result) {
    if (result.length === 0) {
        return null;
    }
    const obj = {};
    while(result.length >= 2){
        const key = result.shift();
        const value = result.shift();
        try {
            obj[key] = JSON.parse(value);
        } catch  {
            obj[key] = value;
        }
    }
    return obj;
}
/**
 * @see https://redis.io/commands/hgetall
 */ class HGetAllCommand extends Command {
    constructor(cmd, opts){
        super([
            "hgetall",
            ...cmd
        ], {
            deserialize: (result)=>deserialize(result),
            ...opts
        });
    }
}

;// CONCATENATED MODULE: ./node_modules/.pnpm/@upstash+redis@1.21.0/node_modules/@upstash/redis/esm/pkg/commands/hincrby.js

/**
 * @see https://redis.io/commands/hincrby
 */ class HIncrByCommand extends Command {
    constructor(cmd, opts){
        super([
            "hincrby",
            ...cmd
        ], opts);
    }
}

;// CONCATENATED MODULE: ./node_modules/.pnpm/@upstash+redis@1.21.0/node_modules/@upstash/redis/esm/pkg/commands/hincrbyfloat.js

/**
 * @see https://redis.io/commands/hincrbyfloat
 */ class HIncrByFloatCommand extends Command {
    constructor(cmd, opts){
        super([
            "hincrbyfloat",
            ...cmd
        ], opts);
    }
}

;// CONCATENATED MODULE: ./node_modules/.pnpm/@upstash+redis@1.21.0/node_modules/@upstash/redis/esm/pkg/commands/hkeys.js

/**
 * @see https://redis.io/commands/hkeys
 */ class HKeysCommand extends Command {
    constructor([key], opts){
        super([
            "hkeys",
            key
        ], opts);
    }
}

;// CONCATENATED MODULE: ./node_modules/.pnpm/@upstash+redis@1.21.0/node_modules/@upstash/redis/esm/pkg/commands/hlen.js

/**
 * @see https://redis.io/commands/hlen
 */ class HLenCommand extends Command {
    constructor(cmd, opts){
        super([
            "hlen",
            ...cmd
        ], opts);
    }
}

;// CONCATENATED MODULE: ./node_modules/.pnpm/@upstash+redis@1.21.0/node_modules/@upstash/redis/esm/pkg/commands/hmget.js

function hmget_deserialize(fields, result) {
    if (result.length === 0 || result.every((field)=>field === null)) {
        return null;
    }
    const obj = {};
    for(let i = 0; i < fields.length; i++){
        try {
            obj[fields[i]] = JSON.parse(result[i]);
        } catch  {
            obj[fields[i]] = result[i];
        }
    }
    return obj;
}
/**
 * hmget returns an object of all requested fields from a hash
 * The field values are returned as an object like this:
 * ```ts
 * {[fieldName: string]: T | null}
 * ```
 *
 * In case the hash does not exist or all fields are empty `null` is returned
 *
 * @see https://redis.io/commands/hmget
 */ class HMGetCommand extends Command {
    constructor([key, ...fields], opts){
        super([
            "hmget",
            key,
            ...fields
        ], {
            deserialize: (result)=>hmget_deserialize(fields, result),
            ...opts
        });
    }
}

;// CONCATENATED MODULE: ./node_modules/.pnpm/@upstash+redis@1.21.0/node_modules/@upstash/redis/esm/pkg/commands/hmset.js

/**
 * @see https://redis.io/commands/hmset
 */ class HMSetCommand extends Command {
    constructor([key, kv], opts){
        super([
            "hmset",
            key,
            ...Object.entries(kv).flatMap(([field, value])=>[
                    field,
                    value
                ])
        ], opts);
    }
}

;// CONCATENATED MODULE: ./node_modules/.pnpm/@upstash+redis@1.21.0/node_modules/@upstash/redis/esm/pkg/commands/hrandfield.js

function hrandfield_deserialize(result) {
    if (result.length === 0) {
        return null;
    }
    const obj = {};
    while(result.length >= 2){
        const key = result.shift();
        const value = result.shift();
        try {
            obj[key] = JSON.parse(value);
        } catch  {
            obj[key] = value;
        }
    }
    return obj;
}
/**
 * @see https://redis.io/commands/hrandfield
 */ class HRandFieldCommand extends Command {
    constructor(cmd, opts){
        const command = [
            "hrandfield",
            cmd[0]
        ];
        if (typeof cmd[1] === "number") {
            command.push(cmd[1]);
        }
        if (cmd[2]) {
            command.push("WITHVALUES");
        }
        super(command, {
            // @ts-ignore TODO:
            deserialize: cmd[2] ? (result)=>hrandfield_deserialize(result) : opts?.deserialize,
            ...opts
        });
    }
}

;// CONCATENATED MODULE: ./node_modules/.pnpm/@upstash+redis@1.21.0/node_modules/@upstash/redis/esm/pkg/commands/hscan.js

/**
 * @see https://redis.io/commands/hscan
 */ class HScanCommand extends Command {
    constructor([key, cursor, cmdOpts], opts){
        const command = [
            "hscan",
            key,
            cursor
        ];
        if (cmdOpts?.match) {
            command.push("match", cmdOpts.match);
        }
        if (typeof cmdOpts?.count === "number") {
            command.push("count", cmdOpts.count);
        }
        super(command, opts);
    }
}

;// CONCATENATED MODULE: ./node_modules/.pnpm/@upstash+redis@1.21.0/node_modules/@upstash/redis/esm/pkg/commands/hset.js

/**
 * @see https://redis.io/commands/hset
 */ class HSetCommand extends Command {
    constructor([key, kv], opts){
        super([
            "hset",
            key,
            ...Object.entries(kv).flatMap(([field, value])=>[
                    field,
                    value
                ])
        ], opts);
    }
}

;// CONCATENATED MODULE: ./node_modules/.pnpm/@upstash+redis@1.21.0/node_modules/@upstash/redis/esm/pkg/commands/hsetnx.js

/**
 * @see https://redis.io/commands/hsetnx
 */ class HSetNXCommand extends Command {
    constructor(cmd, opts){
        super([
            "hsetnx",
            ...cmd
        ], opts);
    }
}

;// CONCATENATED MODULE: ./node_modules/.pnpm/@upstash+redis@1.21.0/node_modules/@upstash/redis/esm/pkg/commands/hstrlen.js

/**
 * @see https://redis.io/commands/hstrlen
 */ class HStrLenCommand extends Command {
    constructor(cmd, opts){
        super([
            "hstrlen",
            ...cmd
        ], opts);
    }
}

;// CONCATENATED MODULE: ./node_modules/.pnpm/@upstash+redis@1.21.0/node_modules/@upstash/redis/esm/pkg/commands/hvals.js

/**
 * @see https://redis.io/commands/hvals
 */ class HValsCommand extends Command {
    constructor(cmd, opts){
        super([
            "hvals",
            ...cmd
        ], opts);
    }
}

;// CONCATENATED MODULE: ./node_modules/.pnpm/@upstash+redis@1.21.0/node_modules/@upstash/redis/esm/pkg/commands/incr.js

/**
 * @see https://redis.io/commands/incr
 */ class IncrCommand extends Command {
    constructor(cmd, opts){
        super([
            "incr",
            ...cmd
        ], opts);
    }
}

;// CONCATENATED MODULE: ./node_modules/.pnpm/@upstash+redis@1.21.0/node_modules/@upstash/redis/esm/pkg/commands/incrby.js

/**
 * @see https://redis.io/commands/incrby
 */ class IncrByCommand extends Command {
    constructor(cmd, opts){
        super([
            "incrby",
            ...cmd
        ], opts);
    }
}

;// CONCATENATED MODULE: ./node_modules/.pnpm/@upstash+redis@1.21.0/node_modules/@upstash/redis/esm/pkg/commands/incrbyfloat.js

/**
 * @see https://redis.io/commands/incrbyfloat
 */ class IncrByFloatCommand extends Command {
    constructor(cmd, opts){
        super([
            "incrbyfloat",
            ...cmd
        ], opts);
    }
}

;// CONCATENATED MODULE: ./node_modules/.pnpm/@upstash+redis@1.21.0/node_modules/@upstash/redis/esm/pkg/commands/keys.js

/**
 * @see https://redis.io/commands/keys
 */ class KeysCommand extends Command {
    constructor(cmd, opts){
        super([
            "keys",
            ...cmd
        ], opts);
    }
}

;// CONCATENATED MODULE: ./node_modules/.pnpm/@upstash+redis@1.21.0/node_modules/@upstash/redis/esm/pkg/commands/lindex.js

class LIndexCommand extends Command {
    constructor(cmd, opts){
        super([
            "lindex",
            ...cmd
        ], opts);
    }
}

;// CONCATENATED MODULE: ./node_modules/.pnpm/@upstash+redis@1.21.0/node_modules/@upstash/redis/esm/pkg/commands/linsert.js

class LInsertCommand extends Command {
    constructor(cmd, opts){
        super([
            "linsert",
            ...cmd
        ], opts);
    }
}

;// CONCATENATED MODULE: ./node_modules/.pnpm/@upstash+redis@1.21.0/node_modules/@upstash/redis/esm/pkg/commands/llen.js

/**
 * @see https://redis.io/commands/llen
 */ class LLenCommand extends Command {
    constructor(cmd, opts){
        super([
            "llen",
            ...cmd
        ], opts);
    }
}

;// CONCATENATED MODULE: ./node_modules/.pnpm/@upstash+redis@1.21.0/node_modules/@upstash/redis/esm/pkg/commands/lmove.js

/**
 * @see https://redis.io/commands/lmove
 */ class LMoveCommand extends Command {
    constructor(cmd, opts){
        super([
            "lmove",
            ...cmd
        ], opts);
    }
}

;// CONCATENATED MODULE: ./node_modules/.pnpm/@upstash+redis@1.21.0/node_modules/@upstash/redis/esm/pkg/commands/lpop.js

/**
 * @see https://redis.io/commands/lpop
 */ class LPopCommand extends Command {
    constructor(cmd, opts){
        super([
            "lpop",
            ...cmd
        ], opts);
    }
}

;// CONCATENATED MODULE: ./node_modules/.pnpm/@upstash+redis@1.21.0/node_modules/@upstash/redis/esm/pkg/commands/lpos.js

/**
 * @see https://redis.io/commands/lpos
 */ class LPosCommand extends Command {
    constructor(cmd, opts){
        const args = [
            "lpos",
            cmd[0],
            cmd[1]
        ];
        if (typeof cmd[2]?.rank === "number") {
            args.push("rank", cmd[2].rank);
        }
        if (typeof cmd[2]?.count === "number") {
            args.push("count", cmd[2].count);
        }
        if (typeof cmd[2]?.maxLen === "number") {
            args.push("maxLen", cmd[2].maxLen);
        }
        super(args, opts);
    }
}

;// CONCATENATED MODULE: ./node_modules/.pnpm/@upstash+redis@1.21.0/node_modules/@upstash/redis/esm/pkg/commands/lpush.js

/**
 * @see https://redis.io/commands/lpush
 */ class LPushCommand extends Command {
    constructor(cmd, opts){
        super([
            "lpush",
            ...cmd
        ], opts);
    }
}

;// CONCATENATED MODULE: ./node_modules/.pnpm/@upstash+redis@1.21.0/node_modules/@upstash/redis/esm/pkg/commands/lpushx.js

/**
 * @see https://redis.io/commands/lpushx
 */ class LPushXCommand extends Command {
    constructor(cmd, opts){
        super([
            "lpushx",
            ...cmd
        ], opts);
    }
}

;// CONCATENATED MODULE: ./node_modules/.pnpm/@upstash+redis@1.21.0/node_modules/@upstash/redis/esm/pkg/commands/lrange.js

class LRangeCommand extends Command {
    constructor(cmd, opts){
        super([
            "lrange",
            ...cmd
        ], opts);
    }
}

;// CONCATENATED MODULE: ./node_modules/.pnpm/@upstash+redis@1.21.0/node_modules/@upstash/redis/esm/pkg/commands/lrem.js

class LRemCommand extends Command {
    constructor(cmd, opts){
        super([
            "lrem",
            ...cmd
        ], opts);
    }
}

;// CONCATENATED MODULE: ./node_modules/.pnpm/@upstash+redis@1.21.0/node_modules/@upstash/redis/esm/pkg/commands/lset.js

class LSetCommand extends Command {
    constructor(cmd, opts){
        super([
            "lset",
            ...cmd
        ], opts);
    }
}

;// CONCATENATED MODULE: ./node_modules/.pnpm/@upstash+redis@1.21.0/node_modules/@upstash/redis/esm/pkg/commands/ltrim.js

class LTrimCommand extends Command {
    constructor(cmd, opts){
        super([
            "ltrim",
            ...cmd
        ], opts);
    }
}

;// CONCATENATED MODULE: ./node_modules/.pnpm/@upstash+redis@1.21.0/node_modules/@upstash/redis/esm/pkg/commands/mget.js

/**
 * @see https://redis.io/commands/mget
 */ class MGetCommand extends Command {
    constructor(cmd, opts){
        super([
            "mget",
            ...cmd
        ], opts);
    }
}

;// CONCATENATED MODULE: ./node_modules/.pnpm/@upstash+redis@1.21.0/node_modules/@upstash/redis/esm/pkg/commands/mset.js

/**
 * @see https://redis.io/commands/mset
 */ class MSetCommand extends Command {
    constructor([kv], opts){
        super([
            "mset",
            ...Object.entries(kv).flatMap(([key, value])=>[
                    key,
                    value
                ])
        ], opts);
    }
}

;// CONCATENATED MODULE: ./node_modules/.pnpm/@upstash+redis@1.21.0/node_modules/@upstash/redis/esm/pkg/commands/msetnx.js

/**
 * @see https://redis.io/commands/msetnx
 */ class MSetNXCommand extends Command {
    constructor([kv], opts){
        super([
            "msetnx",
            ...Object.entries(kv).flatMap((_)=>_)
        ], opts);
    }
}

;// CONCATENATED MODULE: ./node_modules/.pnpm/@upstash+redis@1.21.0/node_modules/@upstash/redis/esm/pkg/commands/persist.js

/**
 * @see https://redis.io/commands/persist
 */ class PersistCommand extends Command {
    constructor(cmd, opts){
        super([
            "persist",
            ...cmd
        ], opts);
    }
}

;// CONCATENATED MODULE: ./node_modules/.pnpm/@upstash+redis@1.21.0/node_modules/@upstash/redis/esm/pkg/commands/pexpire.js

/**
 * @see https://redis.io/commands/pexpire
 */ class PExpireCommand extends Command {
    constructor(cmd, opts){
        super([
            "pexpire",
            ...cmd
        ], opts);
    }
}

;// CONCATENATED MODULE: ./node_modules/.pnpm/@upstash+redis@1.21.0/node_modules/@upstash/redis/esm/pkg/commands/pexpireat.js

/**
 * @see https://redis.io/commands/pexpireat
 */ class PExpireAtCommand extends Command {
    constructor(cmd, opts){
        super([
            "pexpireat",
            ...cmd
        ], opts);
    }
}

;// CONCATENATED MODULE: ./node_modules/.pnpm/@upstash+redis@1.21.0/node_modules/@upstash/redis/esm/pkg/commands/ping.js

/**
 * @see https://redis.io/commands/ping
 */ class PingCommand extends Command {
    constructor(cmd, opts){
        const command = [
            "ping"
        ];
        if (typeof cmd !== "undefined" && typeof cmd[0] !== "undefined") {
            command.push(cmd[0]);
        }
        super(command, opts);
    }
}

;// CONCATENATED MODULE: ./node_modules/.pnpm/@upstash+redis@1.21.0/node_modules/@upstash/redis/esm/pkg/commands/psetex.js

/**
 * @see https://redis.io/commands/psetex
 */ class PSetEXCommand extends Command {
    constructor(cmd, opts){
        super([
            "psetex",
            ...cmd
        ], opts);
    }
}

;// CONCATENATED MODULE: ./node_modules/.pnpm/@upstash+redis@1.21.0/node_modules/@upstash/redis/esm/pkg/commands/pttl.js

/**
 * @see https://redis.io/commands/pttl
 */ class PTtlCommand extends Command {
    constructor(cmd, opts){
        super([
            "pttl",
            ...cmd
        ], opts);
    }
}

;// CONCATENATED MODULE: ./node_modules/.pnpm/@upstash+redis@1.21.0/node_modules/@upstash/redis/esm/pkg/commands/publish.js

/**
 * @see https://redis.io/commands/publish
 */ class PublishCommand extends Command {
    constructor(cmd, opts){
        super([
            "publish",
            ...cmd
        ], opts);
    }
}

;// CONCATENATED MODULE: ./node_modules/.pnpm/@upstash+redis@1.21.0/node_modules/@upstash/redis/esm/pkg/commands/randomkey.js

/**
 * @see https://redis.io/commands/randomkey
 */ class RandomKeyCommand extends Command {
    constructor(opts){
        super([
            "randomkey"
        ], opts);
    }
}

;// CONCATENATED MODULE: ./node_modules/.pnpm/@upstash+redis@1.21.0/node_modules/@upstash/redis/esm/pkg/commands/rename.js

/**
 * @see https://redis.io/commands/rename
 */ class RenameCommand extends Command {
    constructor(cmd, opts){
        super([
            "rename",
            ...cmd
        ], opts);
    }
}

;// CONCATENATED MODULE: ./node_modules/.pnpm/@upstash+redis@1.21.0/node_modules/@upstash/redis/esm/pkg/commands/renamenx.js

/**
 * @see https://redis.io/commands/renamenx
 */ class RenameNXCommand extends Command {
    constructor(cmd, opts){
        super([
            "renamenx",
            ...cmd
        ], opts);
    }
}

;// CONCATENATED MODULE: ./node_modules/.pnpm/@upstash+redis@1.21.0/node_modules/@upstash/redis/esm/pkg/commands/rpop.js

/**
 * @see https://redis.io/commands/rpop
 */ class RPopCommand extends Command {
    constructor(cmd, opts){
        super([
            "rpop",
            ...cmd
        ], opts);
    }
}

;// CONCATENATED MODULE: ./node_modules/.pnpm/@upstash+redis@1.21.0/node_modules/@upstash/redis/esm/pkg/commands/rpush.js

/**
 * @see https://redis.io/commands/rpush
 */ class RPushCommand extends Command {
    constructor(cmd, opts){
        super([
            "rpush",
            ...cmd
        ], opts);
    }
}

;// CONCATENATED MODULE: ./node_modules/.pnpm/@upstash+redis@1.21.0/node_modules/@upstash/redis/esm/pkg/commands/rpushx.js

/**
 * @see https://redis.io/commands/rpushx
 */ class RPushXCommand extends Command {
    constructor(cmd, opts){
        super([
            "rpushx",
            ...cmd
        ], opts);
    }
}

;// CONCATENATED MODULE: ./node_modules/.pnpm/@upstash+redis@1.21.0/node_modules/@upstash/redis/esm/pkg/commands/sadd.js

/**
 * @see https://redis.io/commands/sadd
 */ class SAddCommand extends Command {
    constructor(cmd, opts){
        super([
            "sadd",
            ...cmd
        ], opts);
    }
}

;// CONCATENATED MODULE: ./node_modules/.pnpm/@upstash+redis@1.21.0/node_modules/@upstash/redis/esm/pkg/commands/scan.js

/**
 * @see https://redis.io/commands/scan
 */ class ScanCommand extends Command {
    constructor([cursor, opts], cmdOpts){
        const command = [
            "scan",
            cursor
        ];
        if (opts?.match) {
            command.push("match", opts.match);
        }
        if (typeof opts?.count === "number") {
            command.push("count", opts.count);
        }
        if (opts?.type && opts.type.length > 0) {
            command.push("type", opts.type);
        }
        super(command, cmdOpts);
    }
}

;// CONCATENATED MODULE: ./node_modules/.pnpm/@upstash+redis@1.21.0/node_modules/@upstash/redis/esm/pkg/commands/scard.js

/**
 * @see https://redis.io/commands/scard
 */ class SCardCommand extends Command {
    constructor(cmd, opts){
        super([
            "scard",
            ...cmd
        ], opts);
    }
}

;// CONCATENATED MODULE: ./node_modules/.pnpm/@upstash+redis@1.21.0/node_modules/@upstash/redis/esm/pkg/commands/script_exists.js

/**
 * @see https://redis.io/commands/script-exists
 */ class ScriptExistsCommand extends Command {
    constructor(hashes, opts){
        super([
            "script",
            "exists",
            ...hashes
        ], {
            deserialize: (result)=>result,
            ...opts
        });
    }
}

;// CONCATENATED MODULE: ./node_modules/.pnpm/@upstash+redis@1.21.0/node_modules/@upstash/redis/esm/pkg/commands/script_flush.js

/**
 * @see https://redis.io/commands/script-flush
 */ class ScriptFlushCommand extends Command {
    constructor([opts], cmdOpts){
        const cmd = [
            "script",
            "flush"
        ];
        if (opts?.sync) {
            cmd.push("sync");
        } else if (opts?.async) {
            cmd.push("async");
        }
        super(cmd, cmdOpts);
    }
}

;// CONCATENATED MODULE: ./node_modules/.pnpm/@upstash+redis@1.21.0/node_modules/@upstash/redis/esm/pkg/commands/script_load.js

/**
 * @see https://redis.io/commands/script-load
 */ class ScriptLoadCommand extends Command {
    constructor(args, opts){
        super([
            "script",
            "load",
            ...args
        ], opts);
    }
}

;// CONCATENATED MODULE: ./node_modules/.pnpm/@upstash+redis@1.21.0/node_modules/@upstash/redis/esm/pkg/commands/sdiff.js

/**
 * @see https://redis.io/commands/sdiff
 */ class SDiffCommand extends Command {
    constructor(cmd, opts){
        super([
            "sdiff",
            ...cmd
        ], opts);
    }
}

;// CONCATENATED MODULE: ./node_modules/.pnpm/@upstash+redis@1.21.0/node_modules/@upstash/redis/esm/pkg/commands/sdiffstore.js

/**
 * @see https://redis.io/commands/sdiffstore
 */ class SDiffStoreCommand extends Command {
    constructor(cmd, opts){
        super([
            "sdiffstore",
            ...cmd
        ], opts);
    }
}

;// CONCATENATED MODULE: ./node_modules/.pnpm/@upstash+redis@1.21.0/node_modules/@upstash/redis/esm/pkg/commands/set.js

/**
 * @see https://redis.io/commands/set
 */ class SetCommand extends Command {
    constructor([key, value, opts], cmdOpts){
        const command = [
            "set",
            key,
            value
        ];
        if (opts) {
            if ("nx" in opts && opts.nx) {
                command.push("nx");
            } else if ("xx" in opts && opts.xx) {
                command.push("xx");
            }
            if ("get" in opts && opts.get) {
                command.push("get");
            }
            if ("ex" in opts && typeof opts.ex === "number") {
                command.push("ex", opts.ex);
            } else if ("px" in opts && typeof opts.px === "number") {
                command.push("px", opts.px);
            } else if ("exat" in opts && typeof opts.exat === "number") {
                command.push("exat", opts.exat);
            } else if ("pxat" in opts && typeof opts.pxat === "number") {
                command.push("pxat", opts.pxat);
            } else if ("keepTtl" in opts && opts.keepTtl) {
                command.push("keepTtl", opts.keepTtl);
            }
        }
        super(command, cmdOpts);
    }
}

;// CONCATENATED MODULE: ./node_modules/.pnpm/@upstash+redis@1.21.0/node_modules/@upstash/redis/esm/pkg/commands/setbit.js

/**
 * @see https://redis.io/commands/setbit
 */ class SetBitCommand extends Command {
    constructor(cmd, opts){
        super([
            "setbit",
            ...cmd
        ], opts);
    }
}

;// CONCATENATED MODULE: ./node_modules/.pnpm/@upstash+redis@1.21.0/node_modules/@upstash/redis/esm/pkg/commands/setex.js

/**
 * @see https://redis.io/commands/setex
 */ class SetExCommand extends Command {
    constructor(cmd, opts){
        super([
            "setex",
            ...cmd
        ], opts);
    }
}

;// CONCATENATED MODULE: ./node_modules/.pnpm/@upstash+redis@1.21.0/node_modules/@upstash/redis/esm/pkg/commands/setnx.js

/**
 * @see https://redis.io/commands/setnx
 */ class SetNxCommand extends Command {
    constructor(cmd, opts){
        super([
            "setnx",
            ...cmd
        ], opts);
    }
}

;// CONCATENATED MODULE: ./node_modules/.pnpm/@upstash+redis@1.21.0/node_modules/@upstash/redis/esm/pkg/commands/setrange.js

/**
 * @see https://redis.io/commands/setrange
 */ class SetRangeCommand extends Command {
    constructor(cmd, opts){
        super([
            "setrange",
            ...cmd
        ], opts);
    }
}

;// CONCATENATED MODULE: ./node_modules/.pnpm/@upstash+redis@1.21.0/node_modules/@upstash/redis/esm/pkg/commands/sinter.js

/**
 * @see https://redis.io/commands/sinter
 */ class SInterCommand extends Command {
    constructor(cmd, opts){
        super([
            "sinter",
            ...cmd
        ], opts);
    }
}

;// CONCATENATED MODULE: ./node_modules/.pnpm/@upstash+redis@1.21.0/node_modules/@upstash/redis/esm/pkg/commands/sinterstore.js

/**
 * @see https://redis.io/commands/sinterstore
 */ class SInterStoreCommand extends Command {
    constructor(cmd, opts){
        super([
            "sinterstore",
            ...cmd
        ], opts);
    }
}

;// CONCATENATED MODULE: ./node_modules/.pnpm/@upstash+redis@1.21.0/node_modules/@upstash/redis/esm/pkg/commands/sismember.js

/**
 * @see https://redis.io/commands/sismember
 */ class SIsMemberCommand extends Command {
    constructor(cmd, opts){
        super([
            "sismember",
            ...cmd
        ], opts);
    }
}

;// CONCATENATED MODULE: ./node_modules/.pnpm/@upstash+redis@1.21.0/node_modules/@upstash/redis/esm/pkg/commands/smismember.js

/**
 * @see https://redis.io/commands/smismember
 */ class SMIsMemberCommand extends Command {
    constructor(cmd, opts){
        super([
            "smismember",
            cmd[0],
            ...cmd[1]
        ], opts);
    }
}

;// CONCATENATED MODULE: ./node_modules/.pnpm/@upstash+redis@1.21.0/node_modules/@upstash/redis/esm/pkg/commands/smembers.js

/**
 * @see https://redis.io/commands/smembers
 */ class SMembersCommand extends Command {
    constructor(cmd, opts){
        super([
            "smembers",
            ...cmd
        ], opts);
    }
}

;// CONCATENATED MODULE: ./node_modules/.pnpm/@upstash+redis@1.21.0/node_modules/@upstash/redis/esm/pkg/commands/smove.js

/**
 * @see https://redis.io/commands/smove
 */ class SMoveCommand extends Command {
    constructor(cmd, opts){
        super([
            "smove",
            ...cmd
        ], opts);
    }
}

;// CONCATENATED MODULE: ./node_modules/.pnpm/@upstash+redis@1.21.0/node_modules/@upstash/redis/esm/pkg/commands/spop.js

/**
 * @see https://redis.io/commands/spop
 */ class SPopCommand extends Command {
    constructor([key, count], opts){
        const command = [
            "spop",
            key
        ];
        if (typeof count === "number") {
            command.push(count);
        }
        super(command, opts);
    }
}

;// CONCATENATED MODULE: ./node_modules/.pnpm/@upstash+redis@1.21.0/node_modules/@upstash/redis/esm/pkg/commands/srandmember.js

/**
 * @see https://redis.io/commands/srandmember
 */ class SRandMemberCommand extends Command {
    constructor([key, count], opts){
        const command = [
            "srandmember",
            key
        ];
        if (typeof count === "number") {
            command.push(count);
        }
        super(command, opts);
    }
}

;// CONCATENATED MODULE: ./node_modules/.pnpm/@upstash+redis@1.21.0/node_modules/@upstash/redis/esm/pkg/commands/srem.js

/**
 * @see https://redis.io/commands/srem
 */ class SRemCommand extends Command {
    constructor(cmd, opts){
        super([
            "srem",
            ...cmd
        ], opts);
    }
}

;// CONCATENATED MODULE: ./node_modules/.pnpm/@upstash+redis@1.21.0/node_modules/@upstash/redis/esm/pkg/commands/sscan.js

/**
 * @see https://redis.io/commands/sscan
 */ class SScanCommand extends Command {
    constructor([key, cursor, opts], cmdOpts){
        const command = [
            "sscan",
            key,
            cursor
        ];
        if (opts?.match) {
            command.push("match", opts.match);
        }
        if (typeof opts?.count === "number") {
            command.push("count", opts.count);
        }
        super(command, cmdOpts);
    }
}

;// CONCATENATED MODULE: ./node_modules/.pnpm/@upstash+redis@1.21.0/node_modules/@upstash/redis/esm/pkg/commands/strlen.js

/**
 * @see https://redis.io/commands/strlen
 */ class StrLenCommand extends Command {
    constructor(cmd, opts){
        super([
            "strlen",
            ...cmd
        ], opts);
    }
}

;// CONCATENATED MODULE: ./node_modules/.pnpm/@upstash+redis@1.21.0/node_modules/@upstash/redis/esm/pkg/commands/sunion.js

/**
 * @see https://redis.io/commands/sunion
 */ class SUnionCommand extends Command {
    constructor(cmd, opts){
        super([
            "sunion",
            ...cmd
        ], opts);
    }
}

;// CONCATENATED MODULE: ./node_modules/.pnpm/@upstash+redis@1.21.0/node_modules/@upstash/redis/esm/pkg/commands/sunionstore.js

/**
 * @see https://redis.io/commands/sunionstore
 */ class SUnionStoreCommand extends Command {
    constructor(cmd, opts){
        super([
            "sunionstore",
            ...cmd
        ], opts);
    }
}

;// CONCATENATED MODULE: ./node_modules/.pnpm/@upstash+redis@1.21.0/node_modules/@upstash/redis/esm/pkg/commands/time.js

/**
 * @see https://redis.io/commands/time
 */ class TimeCommand extends Command {
    constructor(opts){
        super([
            "time"
        ], opts);
    }
}

;// CONCATENATED MODULE: ./node_modules/.pnpm/@upstash+redis@1.21.0/node_modules/@upstash/redis/esm/pkg/commands/touch.js

/**
 * @see https://redis.io/commands/touch
 */ class TouchCommand extends Command {
    constructor(cmd, opts){
        super([
            "touch",
            ...cmd
        ], opts);
    }
}

;// CONCATENATED MODULE: ./node_modules/.pnpm/@upstash+redis@1.21.0/node_modules/@upstash/redis/esm/pkg/commands/ttl.js

/**
 * @see https://redis.io/commands/ttl
 */ class TtlCommand extends Command {
    constructor(cmd, opts){
        super([
            "ttl",
            ...cmd
        ], opts);
    }
}

;// CONCATENATED MODULE: ./node_modules/.pnpm/@upstash+redis@1.21.0/node_modules/@upstash/redis/esm/pkg/commands/type.js

/**
 * @see https://redis.io/commands/type
 */ class TypeCommand extends Command {
    constructor(cmd, opts){
        super([
            "type",
            ...cmd
        ], opts);
    }
}

;// CONCATENATED MODULE: ./node_modules/.pnpm/@upstash+redis@1.21.0/node_modules/@upstash/redis/esm/pkg/commands/unlink.js

/**
 * @see https://redis.io/commands/unlink
 */ class UnlinkCommand extends Command {
    constructor(cmd, opts){
        super([
            "unlink",
            ...cmd
        ], opts);
    }
}

;// CONCATENATED MODULE: ./node_modules/.pnpm/@upstash+redis@1.21.0/node_modules/@upstash/redis/esm/pkg/commands/zadd.js

/**
 * @see https://redis.io/commands/zadd
 */ class ZAddCommand extends Command {
    constructor([key, arg1, ...arg2], opts){
        const command = [
            "zadd",
            key
        ];
        if ("nx" in arg1 && arg1.nx) {
            command.push("nx");
        } else if ("xx" in arg1 && arg1.xx) {
            command.push("xx");
        }
        if ("ch" in arg1 && arg1.ch) {
            command.push("ch");
        }
        if ("incr" in arg1 && arg1.incr) {
            command.push("incr");
        }
        if ("score" in arg1 && "member" in arg1) {
            command.push(arg1.score, arg1.member);
        }
        command.push(...arg2.flatMap(({ score, member })=>[
                score,
                member
            ]));
        super(command, opts);
    }
}

;// CONCATENATED MODULE: ./node_modules/.pnpm/@upstash+redis@1.21.0/node_modules/@upstash/redis/esm/pkg/commands/zcard.js

/**
 * @see https://redis.io/commands/zcard
 */ class ZCardCommand extends Command {
    constructor(cmd, opts){
        super([
            "zcard",
            ...cmd
        ], opts);
    }
}

;// CONCATENATED MODULE: ./node_modules/.pnpm/@upstash+redis@1.21.0/node_modules/@upstash/redis/esm/pkg/commands/zcount.js

/**
 * @see https://redis.io/commands/zcount
 */ class ZCountCommand extends Command {
    constructor(cmd, opts){
        super([
            "zcount",
            ...cmd
        ], opts);
    }
}

;// CONCATENATED MODULE: ./node_modules/.pnpm/@upstash+redis@1.21.0/node_modules/@upstash/redis/esm/pkg/commands/zincrby.js

/**
 * @see https://redis.io/commands/zincrby
 */ class ZIncrByCommand extends Command {
    constructor(cmd, opts){
        super([
            "zincrby",
            ...cmd
        ], opts);
    }
}

;// CONCATENATED MODULE: ./node_modules/.pnpm/@upstash+redis@1.21.0/node_modules/@upstash/redis/esm/pkg/commands/zinterstore.js

/**
 * @see https://redis.io/commands/zInterstore
 */ class ZInterStoreCommand extends Command {
    constructor([destination, numKeys, keyOrKeys, opts], cmdOpts){
        const command = [
            "zinterstore",
            destination,
            numKeys
        ];
        if (Array.isArray(keyOrKeys)) {
            command.push(...keyOrKeys);
        } else {
            command.push(keyOrKeys);
        }
        if (opts) {
            if ("weights" in opts && opts.weights) {
                command.push("weights", ...opts.weights);
            } else if ("weight" in opts && typeof opts.weight === "number") {
                command.push("weights", opts.weight);
            }
            if ("aggregate" in opts) {
                command.push("aggregate", opts.aggregate);
            }
        }
        super(command, cmdOpts);
    }
}

;// CONCATENATED MODULE: ./node_modules/.pnpm/@upstash+redis@1.21.0/node_modules/@upstash/redis/esm/pkg/commands/zlexcount.js

/**
 * @see https://redis.io/commands/zlexcount
 */ class ZLexCountCommand extends Command {
    constructor(cmd, opts){
        super([
            "zlexcount",
            ...cmd
        ], opts);
    }
}

;// CONCATENATED MODULE: ./node_modules/.pnpm/@upstash+redis@1.21.0/node_modules/@upstash/redis/esm/pkg/commands/zpopmax.js

/**
 * @see https://redis.io/commands/zpopmax
 */ class ZPopMaxCommand extends Command {
    constructor([key, count], opts){
        const command = [
            "zpopmax",
            key
        ];
        if (typeof count === "number") {
            command.push(count);
        }
        super(command, opts);
    }
}

;// CONCATENATED MODULE: ./node_modules/.pnpm/@upstash+redis@1.21.0/node_modules/@upstash/redis/esm/pkg/commands/zpopmin.js

/**
 * @see https://redis.io/commands/zpopmin
 */ class ZPopMinCommand extends Command {
    constructor([key, count], opts){
        const command = [
            "zpopmin",
            key
        ];
        if (typeof count === "number") {
            command.push(count);
        }
        super(command, opts);
    }
}

;// CONCATENATED MODULE: ./node_modules/.pnpm/@upstash+redis@1.21.0/node_modules/@upstash/redis/esm/pkg/commands/zrange.js

/**
 * @see https://redis.io/commands/zrange
 */ class ZRangeCommand extends Command {
    constructor([key, min, max, opts], cmdOpts){
        const command = [
            "zrange",
            key,
            min,
            max
        ];
        // Either byScore or byLex is allowed
        if (opts?.byScore) {
            command.push("byscore");
        }
        if (opts?.byLex) {
            command.push("bylex");
        }
        if (opts?.rev) {
            command.push("rev");
        }
        if (typeof opts?.count !== "undefined" && typeof opts?.offset !== "undefined") {
            command.push("limit", opts.offset, opts.count);
        }
        if (opts?.withScores) {
            command.push("withscores");
        }
        super(command, cmdOpts);
    }
}

;// CONCATENATED MODULE: ./node_modules/.pnpm/@upstash+redis@1.21.0/node_modules/@upstash/redis/esm/pkg/commands/zrank.js

/**
 *  @see https://redis.io/commands/zrank
 */ class ZRankCommand extends Command {
    constructor(cmd, opts){
        super([
            "zrank",
            ...cmd
        ], opts);
    }
}

;// CONCATENATED MODULE: ./node_modules/.pnpm/@upstash+redis@1.21.0/node_modules/@upstash/redis/esm/pkg/commands/zrem.js

/**
 * @see https://redis.io/commands/zrem
 */ class ZRemCommand extends Command {
    constructor(cmd, opts){
        super([
            "zrem",
            ...cmd
        ], opts);
    }
}

;// CONCATENATED MODULE: ./node_modules/.pnpm/@upstash+redis@1.21.0/node_modules/@upstash/redis/esm/pkg/commands/zremrangebylex.js

/**
 * @see https://redis.io/commands/zremrangebylex
 */ class ZRemRangeByLexCommand extends Command {
    constructor(cmd, opts){
        super([
            "zremrangebylex",
            ...cmd
        ], opts);
    }
}

;// CONCATENATED MODULE: ./node_modules/.pnpm/@upstash+redis@1.21.0/node_modules/@upstash/redis/esm/pkg/commands/zremrangebyrank.js

/**
 * @see https://redis.io/commands/zremrangebyrank
 */ class ZRemRangeByRankCommand extends Command {
    constructor(cmd, opts){
        super([
            "zremrangebyrank",
            ...cmd
        ], opts);
    }
}

;// CONCATENATED MODULE: ./node_modules/.pnpm/@upstash+redis@1.21.0/node_modules/@upstash/redis/esm/pkg/commands/zremrangebyscore.js

/**
 * @see https://redis.io/commands/zremrangebyscore
 */ class ZRemRangeByScoreCommand extends Command {
    constructor(cmd, opts){
        super([
            "zremrangebyscore",
            ...cmd
        ], opts);
    }
}

;// CONCATENATED MODULE: ./node_modules/.pnpm/@upstash+redis@1.21.0/node_modules/@upstash/redis/esm/pkg/commands/zrevrank.js

/**
 *  @see https://redis.io/commands/zrevrank
 */ class ZRevRankCommand extends Command {
    constructor(cmd, opts){
        super([
            "zrevrank",
            ...cmd
        ], opts);
    }
}

;// CONCATENATED MODULE: ./node_modules/.pnpm/@upstash+redis@1.21.0/node_modules/@upstash/redis/esm/pkg/commands/zscan.js

/**
 * @see https://redis.io/commands/zscan
 */ class ZScanCommand extends Command {
    constructor([key, cursor, opts], cmdOpts){
        const command = [
            "zscan",
            key,
            cursor
        ];
        if (opts?.match) {
            command.push("match", opts.match);
        }
        if (typeof opts?.count === "number") {
            command.push("count", opts.count);
        }
        super(command, cmdOpts);
    }
}

;// CONCATENATED MODULE: ./node_modules/.pnpm/@upstash+redis@1.21.0/node_modules/@upstash/redis/esm/pkg/commands/zscore.js

/**
 * @see https://redis.io/commands/zscore
 */ class ZScoreCommand extends Command {
    constructor(cmd, opts){
        super([
            "zscore",
            ...cmd
        ], opts);
    }
}

;// CONCATENATED MODULE: ./node_modules/.pnpm/@upstash+redis@1.21.0/node_modules/@upstash/redis/esm/pkg/commands/zunionstore.js

/**
 * @see https://redis.io/commands/zunionstore
 */ class ZUnionStoreCommand extends Command {
    constructor([destination, numKeys, keyOrKeys, opts], cmdOpts){
        const command = [
            "zunionstore",
            destination,
            numKeys
        ];
        if (Array.isArray(keyOrKeys)) {
            command.push(...keyOrKeys);
        } else {
            command.push(keyOrKeys);
        }
        if (opts) {
            if ("weights" in opts && opts.weights) {
                command.push("weights", ...opts.weights);
            } else if ("weight" in opts && typeof opts.weight === "number") {
                command.push("weights", opts.weight);
            }
            if ("aggregate" in opts) {
                command.push("aggregate", opts.aggregate);
            }
        }
        super(command, cmdOpts);
    }
}

;// CONCATENATED MODULE: ./node_modules/.pnpm/@upstash+redis@1.21.0/node_modules/@upstash/redis/esm/pkg/commands/json_arrappend.js

/**
 * @see https://redis.io/commands/json.arrappend
 */ class JsonArrAppendCommand extends Command {
    constructor(cmd, opts){
        super([
            "JSON.ARRAPPEND",
            ...cmd
        ], opts);
    }
}

;// CONCATENATED MODULE: ./node_modules/.pnpm/@upstash+redis@1.21.0/node_modules/@upstash/redis/esm/pkg/commands/json_arrindex.js

/**
 * @see https://redis.io/commands/json.arrindex
 */ class JsonArrIndexCommand extends Command {
    constructor(cmd, opts){
        super([
            "JSON.ARRINDEX",
            ...cmd
        ], opts);
    }
}

;// CONCATENATED MODULE: ./node_modules/.pnpm/@upstash+redis@1.21.0/node_modules/@upstash/redis/esm/pkg/commands/json_arrinsert.js

/**
 * @see https://redis.io/commands/json.arrinsert
 */ class JsonArrInsertCommand extends Command {
    constructor(cmd, opts){
        super([
            "JSON.ARRINSERT",
            ...cmd
        ], opts);
    }
}

;// CONCATENATED MODULE: ./node_modules/.pnpm/@upstash+redis@1.21.0/node_modules/@upstash/redis/esm/pkg/commands/json_arrlen.js

/**
 * @see https://redis.io/commands/json.arrlen
 */ class JsonArrLenCommand extends Command {
    constructor(cmd, opts){
        super([
            "JSON.ARRLEN",
            cmd[0],
            cmd[1] ?? "$"
        ], opts);
    }
}

;// CONCATENATED MODULE: ./node_modules/.pnpm/@upstash+redis@1.21.0/node_modules/@upstash/redis/esm/pkg/commands/json_arrpop.js

/**
 * @see https://redis.io/commands/json.arrpop
 */ class JsonArrPopCommand extends Command {
    constructor(cmd, opts){
        super([
            "JSON.ARRPOP",
            ...cmd
        ], opts);
    }
}

;// CONCATENATED MODULE: ./node_modules/.pnpm/@upstash+redis@1.21.0/node_modules/@upstash/redis/esm/pkg/commands/json_arrtrim.js

/**
 * @see https://redis.io/commands/json.arrtrim
 */ class JsonArrTrimCommand extends Command {
    constructor(cmd, opts){
        const path = cmd[1] ?? "$";
        const start = cmd[2] ?? 0;
        const stop = cmd[3] ?? 0;
        super([
            "JSON.ARRTRIM",
            cmd[0],
            path,
            start,
            stop
        ], opts);
    }
}

;// CONCATENATED MODULE: ./node_modules/.pnpm/@upstash+redis@1.21.0/node_modules/@upstash/redis/esm/pkg/commands/json_clear.js

/**
 * @see https://redis.io/commands/json.clear
 */ class JsonClearCommand extends Command {
    constructor(cmd, opts){
        super([
            "JSON.CLEAR",
            ...cmd
        ], opts);
    }
}

;// CONCATENATED MODULE: ./node_modules/.pnpm/@upstash+redis@1.21.0/node_modules/@upstash/redis/esm/pkg/commands/json_del.js

/**
 * @see https://redis.io/commands/json.del
 */ class JsonDelCommand extends Command {
    constructor(cmd, opts){
        super([
            "JSON.DEL",
            ...cmd
        ], opts);
    }
}

;// CONCATENATED MODULE: ./node_modules/.pnpm/@upstash+redis@1.21.0/node_modules/@upstash/redis/esm/pkg/commands/json_forget.js

/**
 * @see https://redis.io/commands/json.forget
 */ class JsonForgetCommand extends Command {
    constructor(cmd, opts){
        super([
            "JSON.FORGET",
            ...cmd
        ], opts);
    }
}

;// CONCATENATED MODULE: ./node_modules/.pnpm/@upstash+redis@1.21.0/node_modules/@upstash/redis/esm/pkg/commands/json_get.js

/**
 * @see https://redis.io/commands/json.get
 */ class JsonGetCommand extends Command {
    constructor(cmd, opts){
        const command = [
            "JSON.GET"
        ];
        if (typeof cmd[1] === "string") {
            // @ts-ignore - we know this is a string
            command.push(...cmd);
        } else {
            command.push(cmd[0]);
            if (cmd[1]) {
                if (cmd[1].indent) {
                    command.push("INDENT", cmd[1].indent);
                }
                if (cmd[1].newline) {
                    command.push("NEWLINE", cmd[1].newline);
                }
                if (cmd[1].space) {
                    command.push("SPACE", cmd[1].space);
                }
            }
            // @ts-ignore - we know this is a string
            command.push(...cmd.slice(2));
        }
        super(command, opts);
    }
}

;// CONCATENATED MODULE: ./node_modules/.pnpm/@upstash+redis@1.21.0/node_modules/@upstash/redis/esm/pkg/commands/json_mget.js

/**
 * @see https://redis.io/commands/json.mget
 */ class JsonMGetCommand extends Command {
    constructor(cmd, opts){
        super([
            "JSON.MGET",
            ...cmd[0],
            cmd[1]
        ], opts);
    }
}

;// CONCATENATED MODULE: ./node_modules/.pnpm/@upstash+redis@1.21.0/node_modules/@upstash/redis/esm/pkg/commands/json_numincrby.js

/**
 * @see https://redis.io/commands/json.numincrby
 */ class JsonNumIncrByCommand extends Command {
    constructor(cmd, opts){
        super([
            "JSON.NUMINCRBY",
            ...cmd
        ], opts);
    }
}

;// CONCATENATED MODULE: ./node_modules/.pnpm/@upstash+redis@1.21.0/node_modules/@upstash/redis/esm/pkg/commands/json_nummultby.js

/**
 * @see https://redis.io/commands/json.nummultby
 */ class JsonNumMultByCommand extends Command {
    constructor(cmd, opts){
        super([
            "JSON.NUMMULTBY",
            ...cmd
        ], opts);
    }
}

;// CONCATENATED MODULE: ./node_modules/.pnpm/@upstash+redis@1.21.0/node_modules/@upstash/redis/esm/pkg/commands/json_objkeys.js

/**
 * @see https://redis.io/commands/json.objkeys
 */ class JsonObjKeysCommand extends Command {
    constructor(cmd, opts){
        super([
            "JSON.OBJKEYS",
            ...cmd
        ], opts);
    }
}

;// CONCATENATED MODULE: ./node_modules/.pnpm/@upstash+redis@1.21.0/node_modules/@upstash/redis/esm/pkg/commands/json_objlen.js

/**
 * @see https://redis.io/commands/json.objlen
 */ class JsonObjLenCommand extends Command {
    constructor(cmd, opts){
        super([
            "JSON.OBJLEN",
            ...cmd
        ], opts);
    }
}

;// CONCATENATED MODULE: ./node_modules/.pnpm/@upstash+redis@1.21.0/node_modules/@upstash/redis/esm/pkg/commands/json_resp.js

/**
 * @see https://redis.io/commands/json.resp
 */ class JsonRespCommand extends Command {
    constructor(cmd, opts){
        super([
            "JSON.RESP",
            ...cmd
        ], opts);
    }
}

;// CONCATENATED MODULE: ./node_modules/.pnpm/@upstash+redis@1.21.0/node_modules/@upstash/redis/esm/pkg/commands/json_set.js

/**
 * @see https://redis.io/commands/json.set
 */ class JsonSetCommand extends Command {
    constructor(cmd, opts){
        const command = [
            "JSON.SET",
            cmd[0],
            cmd[1],
            cmd[2]
        ];
        if (cmd[3]) {
            if (cmd[3].nx) {
                command.push("NX");
            } else if (cmd[3].xx) {
                command.push("XX");
            }
        }
        super(command, opts);
    }
}

;// CONCATENATED MODULE: ./node_modules/.pnpm/@upstash+redis@1.21.0/node_modules/@upstash/redis/esm/pkg/commands/json_strappend.js

/**
 * @see https://redis.io/commands/json.strappend
 */ class JsonStrAppendCommand extends Command {
    constructor(cmd, opts){
        super([
            "JSON.STRAPPEND",
            ...cmd
        ], opts);
    }
}

;// CONCATENATED MODULE: ./node_modules/.pnpm/@upstash+redis@1.21.0/node_modules/@upstash/redis/esm/pkg/commands/json_strlen.js

/**
 * @see https://redis.io/commands/json.strlen
 */ class JsonStrLenCommand extends Command {
    constructor(cmd, opts){
        super([
            "JSON.STRLEN",
            ...cmd
        ], opts);
    }
}

;// CONCATENATED MODULE: ./node_modules/.pnpm/@upstash+redis@1.21.0/node_modules/@upstash/redis/esm/pkg/commands/json_toggle.js

/**
 * @see https://redis.io/commands/json.toggle
 */ class JsonToggleCommand extends Command {
    constructor(cmd, opts){
        super([
            "JSON.TOGGLE",
            ...cmd
        ], opts);
    }
}

;// CONCATENATED MODULE: ./node_modules/.pnpm/@upstash+redis@1.21.0/node_modules/@upstash/redis/esm/pkg/commands/json_type.js

/**
 * @see https://redis.io/commands/json.type
 */ class JsonTypeCommand extends Command {
    constructor(cmd, opts){
        super([
            "JSON.TYPE",
            ...cmd
        ], opts);
    }
}

;// CONCATENATED MODULE: ./node_modules/.pnpm/@upstash+redis@1.21.0/node_modules/@upstash/redis/esm/pkg/commands/zmscore.js

/**
 * @see https://redis.io/commands/zmscore
 */ class ZMScoreCommand extends Command {
    constructor(cmd, opts){
        const [key, members] = cmd;
        super([
            "zmscore",
            key,
            ...members
        ], opts);
    }
}

;// CONCATENATED MODULE: ./node_modules/.pnpm/@upstash+redis@1.21.0/node_modules/@upstash/redis/esm/pkg/commands/zdiffstore.js

/**
 * @see https://redis.io/commands/zdiffstore
 */ class ZDiffStoreCommand extends Command {
    constructor(cmd, opts){
        super([
            "zdiffstore",
            ...cmd
        ], opts);
    }
}

;// CONCATENATED MODULE: ./node_modules/.pnpm/@upstash+redis@1.21.0/node_modules/@upstash/redis/esm/pkg/pipeline.js





/**
 * Upstash REST API supports command pipelining to send multiple commands in
 * batch, instead of sending each command one by one and waiting for a response.
 * When using pipelines, several commands are sent using a single HTTP request,
 * and a single JSON array response is returned. Each item in the response array
 * corresponds to the command in the same order within the pipeline.
 *
 * **NOTE:**
 *
 * Execution of the pipeline is not atomic. Even though each command in
 * the pipeline will be executed in order, commands sent by other clients can
 * interleave with the pipeline.
 *
 * **Examples:**
 *
 * ```ts
 *  const p = redis.pipeline() // or redis.multi()
 * p.set("key","value")
 * p.get("key")
 * const res = await p.exec()
 * ```
 *
 * You can also chain commands together
 * ```ts
 * const p = redis.pipeline()
 * const res = await p.set("key","value").get("key").exec()
 * ```
 *
 * Return types are inferred if all commands are chained, but you can still
 * override the response type manually:
 * ```ts
 *  redis.pipeline()
 *   .set("key", { greeting: "hello"})
 *   .get("key")
 *   .exec<["OK", { greeting: string } ]>()
 *
 * ```
 */ class Pipeline {
    constructor(opts){
        Object.defineProperty(this, "client", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        Object.defineProperty(this, "commands", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        Object.defineProperty(this, "commandOptions", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        Object.defineProperty(this, "multiExec", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        /**
         * Send the pipeline request to upstash.
         *
         * Returns an array with the results of all pipelined commands.
         *
         * If all commands are statically chained from start to finish, types are inferred. You can still define a return type manually if necessary though:
         * ```ts
         * const p = redis.pipeline()
         * p.get("key")
         * const result = p.exec<[{ greeting: string }]>()
         * ```
         */ Object.defineProperty(this, "exec", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: async ()=>{
                if (this.commands.length === 0) {
                    throw new Error("Pipeline is empty");
                }
                const path = this.multiExec ? [
                    "multi-exec"
                ] : [
                    "pipeline"
                ];
                const res = await this.client.request({
                    path,
                    body: Object.values(this.commands).map((c)=>c.command)
                });
                return res.map(({ error, result }, i)=>{
                    if (error) {
                        throw new UpstashError(`Command ${i + 1} [ ${this.commands[i].command[0]} ] failed: ${error}`);
                    }
                    return this.commands[i].deserialize(result);
                });
            }
        });
        /**
         * @see https://redis.io/commands/append
         */ Object.defineProperty(this, "append", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (...args)=>this.chain(new AppendCommand(args, this.commandOptions))
        });
        /**
         * @see https://redis.io/commands/bitcount
         */ Object.defineProperty(this, "bitcount", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (...args)=>this.chain(new BitCountCommand(args, this.commandOptions))
        });
        /**
         * @see https://redis.io/commands/bitop
         */ Object.defineProperty(this, "bitop", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (op, destinationKey, sourceKey, ...sourceKeys)=>this.chain(new BitOpCommand([
                    op,
                    destinationKey,
                    sourceKey,
                    ...sourceKeys
                ], this.commandOptions))
        });
        /**
         * @see https://redis.io/commands/bitpos
         */ Object.defineProperty(this, "bitpos", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (...args)=>this.chain(new BitPosCommand(args, this.commandOptions))
        });
        /**
         * @see https://redis.io/commands/zdiffstore
         */ Object.defineProperty(this, "zdiffstore", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (...args)=>this.chain(new ZDiffStoreCommand(args, this.commandOptions))
        });
        /**
         * @see https://redis.io/commands/dbsize
         */ Object.defineProperty(this, "dbsize", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: ()=>this.chain(new DBSizeCommand(this.commandOptions))
        });
        /**
         * @see https://redis.io/commands/decr
         */ Object.defineProperty(this, "decr", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (...args)=>this.chain(new DecrCommand(args, this.commandOptions))
        });
        /**
         * @see https://redis.io/commands/decrby
         */ Object.defineProperty(this, "decrby", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (...args)=>this.chain(new DecrByCommand(args, this.commandOptions))
        });
        /**
         * @see https://redis.io/commands/del
         */ Object.defineProperty(this, "del", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (...args)=>this.chain(new DelCommand(args, this.commandOptions))
        });
        /**
         * @see https://redis.io/commands/echo
         */ Object.defineProperty(this, "echo", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (...args)=>this.chain(new EchoCommand(args, this.commandOptions))
        });
        /**
         * @see https://redis.io/commands/eval
         */ Object.defineProperty(this, "eval", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (...args)=>this.chain(new EvalCommand(args, this.commandOptions))
        });
        /**
         * @see https://redis.io/commands/evalsha
         */ Object.defineProperty(this, "evalsha", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (...args)=>this.chain(new EvalshaCommand(args, this.commandOptions))
        });
        /**
         * @see https://redis.io/commands/exists
         */ Object.defineProperty(this, "exists", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (...args)=>this.chain(new ExistsCommand(args, this.commandOptions))
        });
        /**
         * @see https://redis.io/commands/expire
         */ Object.defineProperty(this, "expire", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (...args)=>this.chain(new ExpireCommand(args, this.commandOptions))
        });
        /**
         * @see https://redis.io/commands/expireat
         */ Object.defineProperty(this, "expireat", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (...args)=>this.chain(new ExpireAtCommand(args, this.commandOptions))
        });
        /**
         * @see https://redis.io/commands/flushall
         */ Object.defineProperty(this, "flushall", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (args)=>this.chain(new FlushAllCommand(args, this.commandOptions))
        });
        /**
         * @see https://redis.io/commands/flushdb
         */ Object.defineProperty(this, "flushdb", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (...args)=>this.chain(new FlushDBCommand(args, this.commandOptions))
        });
        /**
         * @see https://redis.io/commands/get
         */ Object.defineProperty(this, "get", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (...args)=>this.chain(new GetCommand(args, this.commandOptions))
        });
        /**
         * @see https://redis.io/commands/getbit
         */ Object.defineProperty(this, "getbit", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (...args)=>this.chain(new GetBitCommand(args, this.commandOptions))
        });
        /**
         * @see https://redis.io/commands/getdel
         */ Object.defineProperty(this, "getdel", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (...args)=>this.chain(new GetDelCommand(args, this.commandOptions))
        });
        /**
         * @see https://redis.io/commands/getrange
         */ Object.defineProperty(this, "getrange", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (...args)=>this.chain(new GetRangeCommand(args, this.commandOptions))
        });
        /**
         * @see https://redis.io/commands/getset
         */ Object.defineProperty(this, "getset", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (key, value)=>this.chain(new GetSetCommand([
                    key,
                    value
                ], this.commandOptions))
        });
        /**
         * @see https://redis.io/commands/hdel
         */ Object.defineProperty(this, "hdel", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (...args)=>this.chain(new HDelCommand(args, this.commandOptions))
        });
        /**
         * @see https://redis.io/commands/hexists
         */ Object.defineProperty(this, "hexists", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (...args)=>this.chain(new HExistsCommand(args, this.commandOptions))
        });
        /**
         * @see https://redis.io/commands/hget
         */ Object.defineProperty(this, "hget", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (...args)=>this.chain(new HGetCommand(args, this.commandOptions))
        });
        /**
         * @see https://redis.io/commands/hgetall
         */ Object.defineProperty(this, "hgetall", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (...args)=>this.chain(new HGetAllCommand(args, this.commandOptions))
        });
        /**
         * @see https://redis.io/commands/hincrby
         */ Object.defineProperty(this, "hincrby", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (...args)=>this.chain(new HIncrByCommand(args, this.commandOptions))
        });
        /**
         * @see https://redis.io/commands/hincrbyfloat
         */ Object.defineProperty(this, "hincrbyfloat", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (...args)=>this.chain(new HIncrByFloatCommand(args, this.commandOptions))
        });
        /**
         * @see https://redis.io/commands/hkeys
         */ Object.defineProperty(this, "hkeys", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (...args)=>this.chain(new HKeysCommand(args, this.commandOptions))
        });
        /**
         * @see https://redis.io/commands/hlen
         */ Object.defineProperty(this, "hlen", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (...args)=>this.chain(new HLenCommand(args, this.commandOptions))
        });
        /**
         * @see https://redis.io/commands/hmget
         */ Object.defineProperty(this, "hmget", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (...args)=>this.chain(new HMGetCommand(args, this.commandOptions))
        });
        /**
         * @see https://redis.io/commands/hmset
         */ Object.defineProperty(this, "hmset", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (key, kv)=>this.chain(new HMSetCommand([
                    key,
                    kv
                ], this.commandOptions))
        });
        /**
         * @see https://redis.io/commands/hrandfield
         */ Object.defineProperty(this, "hrandfield", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (key, count, withValues)=>this.chain(new HRandFieldCommand([
                    key,
                    count,
                    withValues
                ], this.commandOptions))
        });
        /**
         * @see https://redis.io/commands/hscan
         */ Object.defineProperty(this, "hscan", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (...args)=>this.chain(new HScanCommand(args, this.commandOptions))
        });
        /**
         * @see https://redis.io/commands/hset
         */ Object.defineProperty(this, "hset", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (key, kv)=>this.chain(new HSetCommand([
                    key,
                    kv
                ], this.commandOptions))
        });
        /**
         * @see https://redis.io/commands/hsetnx
         */ Object.defineProperty(this, "hsetnx", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (key, field, value)=>this.chain(new HSetNXCommand([
                    key,
                    field,
                    value
                ], this.commandOptions))
        });
        /**
         * @see https://redis.io/commands/hstrlen
         */ Object.defineProperty(this, "hstrlen", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (...args)=>this.chain(new HStrLenCommand(args, this.commandOptions))
        });
        /**
         * @see https://redis.io/commands/hvals
         */ Object.defineProperty(this, "hvals", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (...args)=>this.chain(new HValsCommand(args, this.commandOptions))
        });
        /**
         * @see https://redis.io/commands/incr
         */ Object.defineProperty(this, "incr", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (...args)=>this.chain(new IncrCommand(args, this.commandOptions))
        });
        /**
         * @see https://redis.io/commands/incrby
         */ Object.defineProperty(this, "incrby", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (...args)=>this.chain(new IncrByCommand(args, this.commandOptions))
        });
        /**
         * @see https://redis.io/commands/incrbyfloat
         */ Object.defineProperty(this, "incrbyfloat", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (...args)=>this.chain(new IncrByFloatCommand(args, this.commandOptions))
        });
        /**
         * @see https://redis.io/commands/keys
         */ Object.defineProperty(this, "keys", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (...args)=>this.chain(new KeysCommand(args, this.commandOptions))
        });
        /**
         * @see https://redis.io/commands/lindex
         */ Object.defineProperty(this, "lindex", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (...args)=>this.chain(new LIndexCommand(args, this.commandOptions))
        });
        /**
         * @see https://redis.io/commands/linsert
         */ Object.defineProperty(this, "linsert", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (key, direction, pivot, value)=>this.chain(new LInsertCommand([
                    key,
                    direction,
                    pivot,
                    value
                ], this.commandOptions))
        });
        /**
         * @see https://redis.io/commands/llen
         */ Object.defineProperty(this, "llen", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (...args)=>this.chain(new LLenCommand(args, this.commandOptions))
        });
        /**
         * @see https://redis.io/commands/lmove
         */ Object.defineProperty(this, "lmove", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (...args)=>this.chain(new LMoveCommand(args, this.commandOptions))
        });
        /**
         * @see https://redis.io/commands/lpop
         */ Object.defineProperty(this, "lpop", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (...args)=>this.chain(new LPopCommand(args, this.commandOptions))
        });
        /**
         * @see https://redis.io/commands/lpos
         */ Object.defineProperty(this, "lpos", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (...args)=>this.chain(new LPosCommand(args, this.commandOptions))
        });
        /**
         * @see https://redis.io/commands/lpush
         */ Object.defineProperty(this, "lpush", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (key, ...elements)=>this.chain(new LPushCommand([
                    key,
                    ...elements
                ], this.commandOptions))
        });
        /**
         * @see https://redis.io/commands/lpushx
         */ Object.defineProperty(this, "lpushx", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (key, ...elements)=>this.chain(new LPushXCommand([
                    key,
                    ...elements
                ], this.commandOptions))
        });
        /**
         * @see https://redis.io/commands/lrange
         */ Object.defineProperty(this, "lrange", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (...args)=>this.chain(new LRangeCommand(args, this.commandOptions))
        });
        /**
         * @see https://redis.io/commands/lrem
         */ Object.defineProperty(this, "lrem", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (key, count, value)=>this.chain(new LRemCommand([
                    key,
                    count,
                    value
                ], this.commandOptions))
        });
        /**
         * @see https://redis.io/commands/lset
         */ Object.defineProperty(this, "lset", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (key, index, value)=>this.chain(new LSetCommand([
                    key,
                    index,
                    value
                ], this.commandOptions))
        });
        /**
         * @see https://redis.io/commands/ltrim
         */ Object.defineProperty(this, "ltrim", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (...args)=>this.chain(new LTrimCommand(args, this.commandOptions))
        });
        /**
         * @see https://redis.io/commands/mget
         */ Object.defineProperty(this, "mget", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (...args)=>this.chain(new MGetCommand(args, this.commandOptions))
        });
        /**
         * @see https://redis.io/commands/mset
         */ Object.defineProperty(this, "mset", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (kv)=>this.chain(new MSetCommand([
                    kv
                ], this.commandOptions))
        });
        /**
         * @see https://redis.io/commands/msetnx
         */ Object.defineProperty(this, "msetnx", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (kv)=>this.chain(new MSetNXCommand([
                    kv
                ], this.commandOptions))
        });
        /**
         * @see https://redis.io/commands/persist
         */ Object.defineProperty(this, "persist", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (...args)=>this.chain(new PersistCommand(args, this.commandOptions))
        });
        /**
         * @see https://redis.io/commands/pexpire
         */ Object.defineProperty(this, "pexpire", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (...args)=>this.chain(new PExpireCommand(args, this.commandOptions))
        });
        /**
         * @see https://redis.io/commands/pexpireat
         */ Object.defineProperty(this, "pexpireat", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (...args)=>this.chain(new PExpireAtCommand(args, this.commandOptions))
        });
        /**
         * @see https://redis.io/commands/ping
         */ Object.defineProperty(this, "ping", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (args)=>this.chain(new PingCommand(args, this.commandOptions))
        });
        /**
         * @see https://redis.io/commands/psetex
         */ Object.defineProperty(this, "psetex", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (key, ttl, value)=>this.chain(new PSetEXCommand([
                    key,
                    ttl,
                    value
                ], this.commandOptions))
        });
        /**
         * @see https://redis.io/commands/pttl
         */ Object.defineProperty(this, "pttl", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (...args)=>this.chain(new PTtlCommand(args, this.commandOptions))
        });
        /**
         * @see https://redis.io/commands/publish
         */ Object.defineProperty(this, "publish", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (...args)=>this.chain(new PublishCommand(args, this.commandOptions))
        });
        /**
         * @see https://redis.io/commands/randomkey
         */ Object.defineProperty(this, "randomkey", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: ()=>this.chain(new RandomKeyCommand(this.commandOptions))
        });
        /**
         * @see https://redis.io/commands/rename
         */ Object.defineProperty(this, "rename", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (...args)=>this.chain(new RenameCommand(args, this.commandOptions))
        });
        /**
         * @see https://redis.io/commands/renamenx
         */ Object.defineProperty(this, "renamenx", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (...args)=>this.chain(new RenameNXCommand(args, this.commandOptions))
        });
        /**
         * @see https://redis.io/commands/rpop
         */ Object.defineProperty(this, "rpop", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (...args)=>this.chain(new RPopCommand(args, this.commandOptions))
        });
        /**
         * @see https://redis.io/commands/rpush
         */ Object.defineProperty(this, "rpush", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (key, ...elements)=>this.chain(new RPushCommand([
                    key,
                    ...elements
                ], this.commandOptions))
        });
        /**
         * @see https://redis.io/commands/rpushx
         */ Object.defineProperty(this, "rpushx", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (key, ...elements)=>this.chain(new RPushXCommand([
                    key,
                    ...elements
                ], this.commandOptions))
        });
        /**
         * @see https://redis.io/commands/sadd
         */ Object.defineProperty(this, "sadd", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (key, ...members)=>this.chain(new SAddCommand([
                    key,
                    ...members
                ], this.commandOptions))
        });
        /**
         * @see https://redis.io/commands/scan
         */ Object.defineProperty(this, "scan", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (...args)=>this.chain(new ScanCommand(args, this.commandOptions))
        });
        /**
         * @see https://redis.io/commands/scard
         */ Object.defineProperty(this, "scard", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (...args)=>this.chain(new SCardCommand(args, this.commandOptions))
        });
        /**
         * @see https://redis.io/commands/script-exists
         */ Object.defineProperty(this, "scriptExists", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (...args)=>this.chain(new ScriptExistsCommand(args, this.commandOptions))
        });
        /**
         * @see https://redis.io/commands/script-flush
         */ Object.defineProperty(this, "scriptFlush", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (...args)=>this.chain(new ScriptFlushCommand(args, this.commandOptions))
        });
        /**
         * @see https://redis.io/commands/script-load
         */ Object.defineProperty(this, "scriptLoad", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (...args)=>this.chain(new ScriptLoadCommand(args, this.commandOptions))
        });
        /*)*
         * @see https://redis.io/commands/sdiff
         */ Object.defineProperty(this, "sdiff", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (...args)=>this.chain(new SDiffCommand(args, this.commandOptions))
        });
        /**
         * @see https://redis.io/commands/sdiffstore
         */ Object.defineProperty(this, "sdiffstore", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (...args)=>this.chain(new SDiffStoreCommand(args, this.commandOptions))
        });
        /**
         * @see https://redis.io/commands/set
         */ Object.defineProperty(this, "set", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (key, value, opts)=>this.chain(new SetCommand([
                    key,
                    value,
                    opts
                ], this.commandOptions))
        });
        /**
         * @see https://redis.io/commands/setbit
         */ Object.defineProperty(this, "setbit", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (...args)=>this.chain(new SetBitCommand(args, this.commandOptions))
        });
        /**
         * @see https://redis.io/commands/setex
         */ Object.defineProperty(this, "setex", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (key, ttl, value)=>this.chain(new SetExCommand([
                    key,
                    ttl,
                    value
                ], this.commandOptions))
        });
        /**
         * @see https://redis.io/commands/setnx
         */ Object.defineProperty(this, "setnx", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (key, value)=>this.chain(new SetNxCommand([
                    key,
                    value
                ], this.commandOptions))
        });
        /**
         * @see https://redis.io/commands/setrange
         */ Object.defineProperty(this, "setrange", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (...args)=>this.chain(new SetRangeCommand(args, this.commandOptions))
        });
        /**
         * @see https://redis.io/commands/sinter
         */ Object.defineProperty(this, "sinter", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (...args)=>this.chain(new SInterCommand(args, this.commandOptions))
        });
        /**
         * @see https://redis.io/commands/sinterstore
         */ Object.defineProperty(this, "sinterstore", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (...args)=>this.chain(new SInterStoreCommand(args, this.commandOptions))
        });
        /**
         * @see https://redis.io/commands/sismember
         */ Object.defineProperty(this, "sismember", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (key, member)=>this.chain(new SIsMemberCommand([
                    key,
                    member
                ], this.commandOptions))
        });
        /**
         * @see https://redis.io/commands/smembers
         */ Object.defineProperty(this, "smembers", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (...args)=>this.chain(new SMembersCommand(args, this.commandOptions))
        });
        /**
         * @see https://redis.io/commands/smismember
         */ Object.defineProperty(this, "smismember", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (key, members)=>this.chain(new SMIsMemberCommand([
                    key,
                    members
                ], this.commandOptions))
        });
        /**
         * @see https://redis.io/commands/smove
         */ Object.defineProperty(this, "smove", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (source, destination, member)=>this.chain(new SMoveCommand([
                    source,
                    destination,
                    member
                ], this.commandOptions))
        });
        /**
         * @see https://redis.io/commands/spop
         */ Object.defineProperty(this, "spop", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (...args)=>this.chain(new SPopCommand(args, this.commandOptions))
        });
        /**
         * @see https://redis.io/commands/srandmember
         */ Object.defineProperty(this, "srandmember", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (...args)=>this.chain(new SRandMemberCommand(args, this.commandOptions))
        });
        /**
         * @see https://redis.io/commands/srem
         */ Object.defineProperty(this, "srem", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (key, ...members)=>this.chain(new SRemCommand([
                    key,
                    ...members
                ], this.commandOptions))
        });
        /**
         * @see https://redis.io/commands/sscan
         */ Object.defineProperty(this, "sscan", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (...args)=>this.chain(new SScanCommand(args, this.commandOptions))
        });
        /**
         * @see https://redis.io/commands/strlen
         */ Object.defineProperty(this, "strlen", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (...args)=>this.chain(new StrLenCommand(args, this.commandOptions))
        });
        /**
         * @see https://redis.io/commands/sunion
         */ Object.defineProperty(this, "sunion", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (...args)=>this.chain(new SUnionCommand(args, this.commandOptions))
        });
        /**
         * @see https://redis.io/commands/sunionstore
         */ Object.defineProperty(this, "sunionstore", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (...args)=>this.chain(new SUnionStoreCommand(args, this.commandOptions))
        });
        /**
         * @see https://redis.io/commands/time
         */ Object.defineProperty(this, "time", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: ()=>this.chain(new TimeCommand(this.commandOptions))
        });
        /**
         * @see https://redis.io/commands/touch
         */ Object.defineProperty(this, "touch", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (...args)=>this.chain(new TouchCommand(args, this.commandOptions))
        });
        /**
         * @see https://redis.io/commands/ttl
         */ Object.defineProperty(this, "ttl", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (...args)=>this.chain(new TtlCommand(args, this.commandOptions))
        });
        /**
         * @see https://redis.io/commands/type
         */ Object.defineProperty(this, "type", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (...args)=>this.chain(new TypeCommand(args, this.commandOptions))
        });
        /**
         * @see https://redis.io/commands/unlink
         */ Object.defineProperty(this, "unlink", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (...args)=>this.chain(new UnlinkCommand(args, this.commandOptions))
        });
        /**
         * @see https://redis.io/commands/zadd
         */ Object.defineProperty(this, "zadd", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (...args)=>{
                if ("score" in args[1]) {
                    return this.chain(new ZAddCommand([
                        args[0],
                        args[1],
                        ...args.slice(2)
                    ], this.commandOptions));
                }
                return this.chain(new ZAddCommand([
                    args[0],
                    args[1],
                    ...args.slice(2)
                ], this.commandOptions));
            }
        });
        /**
         * @see https://redis.io/commands/zcard
         */ Object.defineProperty(this, "zcard", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (...args)=>this.chain(new ZCardCommand(args, this.commandOptions))
        });
        /**
         * @see https://redis.io/commands/zcount
         */ Object.defineProperty(this, "zcount", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (...args)=>this.chain(new ZCountCommand(args, this.commandOptions))
        });
        /**
         * @see https://redis.io/commands/zincrby
         */ Object.defineProperty(this, "zincrby", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (key, increment, member)=>this.chain(new ZIncrByCommand([
                    key,
                    increment,
                    member
                ], this.commandOptions))
        });
        /**
         * @see https://redis.io/commands/zinterstore
         */ Object.defineProperty(this, "zinterstore", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (...args)=>this.chain(new ZInterStoreCommand(args, this.commandOptions))
        });
        /**
         * @see https://redis.io/commands/zlexcount
         */ Object.defineProperty(this, "zlexcount", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (...args)=>this.chain(new ZLexCountCommand(args, this.commandOptions))
        });
        /**
         * @see https://redis.io/commands/zmscore
         */ Object.defineProperty(this, "zmscore", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (...args)=>this.chain(new ZMScoreCommand(args, this.commandOptions))
        });
        /**
         * @see https://redis.io/commands/zpopmax
         */ Object.defineProperty(this, "zpopmax", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (...args)=>this.chain(new ZPopMaxCommand(args, this.commandOptions))
        });
        /**
         * @see https://redis.io/commands/zpopmin
         */ Object.defineProperty(this, "zpopmin", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (...args)=>this.chain(new ZPopMinCommand(args, this.commandOptions))
        });
        /**
         * @see https://redis.io/commands/zrange
         */ Object.defineProperty(this, "zrange", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (...args)=>this.chain(new ZRangeCommand(args, this.commandOptions))
        });
        /**
         * @see https://redis.io/commands/zrank
         */ Object.defineProperty(this, "zrank", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (key, member)=>this.chain(new ZRankCommand([
                    key,
                    member
                ], this.commandOptions))
        });
        /**
         * @see https://redis.io/commands/zrem
         */ Object.defineProperty(this, "zrem", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (key, ...members)=>this.chain(new ZRemCommand([
                    key,
                    ...members
                ], this.commandOptions))
        });
        /**
         * @see https://redis.io/commands/zremrangebylex
         */ Object.defineProperty(this, "zremrangebylex", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (...args)=>this.chain(new ZRemRangeByLexCommand(args, this.commandOptions))
        });
        /**
         * @see https://redis.io/commands/zremrangebyrank
         */ Object.defineProperty(this, "zremrangebyrank", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (...args)=>this.chain(new ZRemRangeByRankCommand(args, this.commandOptions))
        });
        /**
         * @see https://redis.io/commands/zremrangebyscore
         */ Object.defineProperty(this, "zremrangebyscore", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (...args)=>this.chain(new ZRemRangeByScoreCommand(args, this.commandOptions))
        });
        /**
         * @see https://redis.io/commands/zrevrank
         */ Object.defineProperty(this, "zrevrank", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (key, member)=>this.chain(new ZRevRankCommand([
                    key,
                    member
                ], this.commandOptions))
        });
        /**
         * @see https://redis.io/commands/zscan
         */ Object.defineProperty(this, "zscan", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (...args)=>this.chain(new ZScanCommand(args, this.commandOptions))
        });
        /**
         * @see https://redis.io/commands/zscore
         */ Object.defineProperty(this, "zscore", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (key, member)=>this.chain(new ZScoreCommand([
                    key,
                    member
                ], this.commandOptions))
        });
        /**
         * @see https://redis.io/commands/zunionstore
         */ Object.defineProperty(this, "zunionstore", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (...args)=>this.chain(new ZUnionStoreCommand(args, this.commandOptions))
        });
        this.client = opts.client;
        this.commands = []; // the TCommands generic in the class definition is only used for carrying through chained command types and should never be explicitly set when instantiating the class
        this.commandOptions = opts.commandOptions;
        this.multiExec = opts.multiExec ?? false;
    }
    /**
     * Pushes a command into the pipeline and returns a chainable instance of the
     * pipeline
     */ chain(command) {
        this.commands.push(command);
        return this; // TS thinks we're returning Pipeline<[]> here, because we're not creating a new instance of the class, hence the cast
    }
    /**
     * @see https://redis.io/commands/?group=json
     */ get json() {
        return {
            /**
             * @see https://redis.io/commands/json.arrappend
             */ arrappend: (...args)=>this.chain(new JsonArrAppendCommand(args, this.commandOptions)),
            /**
             * @see https://redis.io/commands/json.arrindex
             */ arrindex: (...args)=>this.chain(new JsonArrIndexCommand(args, this.commandOptions)),
            /**
             * @see https://redis.io/commands/json.arrinsert
             */ arrinsert: (...args)=>this.chain(new JsonArrInsertCommand(args, this.commandOptions)),
            /**
             * @see https://redis.io/commands/json.arrlen
             */ arrlen: (...args)=>this.chain(new JsonArrLenCommand(args, this.commandOptions)),
            /**
             * @see https://redis.io/commands/json.arrpop
             */ arrpop: (...args)=>this.chain(new JsonArrPopCommand(args, this.commandOptions)),
            /**
             * @see https://redis.io/commands/json.arrtrim
             */ arrtrim: (...args)=>this.chain(new JsonArrTrimCommand(args, this.commandOptions)),
            /**
             * @see https://redis.io/commands/json.clear
             */ clear: (...args)=>this.chain(new JsonClearCommand(args, this.commandOptions)),
            /**
             * @see https://redis.io/commands/json.del
             */ del: (...args)=>this.chain(new JsonDelCommand(args, this.commandOptions)),
            /**
             * @see https://redis.io/commands/json.forget
             */ forget: (...args)=>this.chain(new JsonForgetCommand(args, this.commandOptions)),
            /**
             * @see https://redis.io/commands/json.get
             */ get: (...args)=>this.chain(new JsonGetCommand(args, this.commandOptions)),
            /**
             * @see https://redis.io/commands/json.mget
             */ mget: (...args)=>this.chain(new JsonMGetCommand(args, this.commandOptions)),
            /**
             * @see https://redis.io/commands/json.numincrby
             */ numincrby: (...args)=>this.chain(new JsonNumIncrByCommand(args, this.commandOptions)),
            /**
             * @see https://redis.io/commands/json.nummultby
             */ nummultby: (...args)=>this.chain(new JsonNumMultByCommand(args, this.commandOptions)),
            /**
             * @see https://redis.io/commands/json.objkeys
             */ objkeys: (...args)=>this.chain(new JsonObjKeysCommand(args, this.commandOptions)),
            /**
             * @see https://redis.io/commands/json.objlen
             */ objlen: (...args)=>this.chain(new JsonObjLenCommand(args, this.commandOptions)),
            /**
             * @see https://redis.io/commands/json.resp
             */ resp: (...args)=>this.chain(new JsonRespCommand(args, this.commandOptions)),
            /**
             * @see https://redis.io/commands/json.set
             */ set: (...args)=>this.chain(new JsonSetCommand(args, this.commandOptions)),
            /**
             * @see https://redis.io/commands/json.strappend
             */ strappend: (...args)=>this.chain(new JsonStrAppendCommand(args, this.commandOptions)),
            /**
             * @see https://redis.io/commands/json.strlen
             */ strlen: (...args)=>this.chain(new JsonStrLenCommand(args, this.commandOptions)),
            /**
             * @see https://redis.io/commands/json.toggle
             */ toggle: (...args)=>this.chain(new JsonToggleCommand(args, this.commandOptions)),
            /**
             * @see https://redis.io/commands/json.type
             */ type: (...args)=>this.chain(new JsonTypeCommand(args, this.commandOptions))
        };
    }
}

;// CONCATENATED MODULE: ./node_modules/.pnpm/@upstash+redis@1.21.0/node_modules/@upstash/redis/esm/deps/deno.land/x/base64@v0.2.1/base.js
function getLengths(b64) {
    const len = b64.length;
    // if (len % 4 > 0) {
    //   throw new TypeError("Invalid string. Length must be a multiple of 4");
    // }
    // Trim off extra bytes after placeholder bytes are found
    // See: https://github.com/beatgammit/base64-js/issues/42
    let validLen = b64.indexOf("=");
    if (validLen === -1) {
        validLen = len;
    }
    const placeHoldersLen = validLen === len ? 0 : 4 - validLen % 4;
    return [
        validLen,
        placeHoldersLen
    ];
}
function init(lookup, revLookup, urlsafe = false) {
    function _byteLength(validLen, placeHoldersLen) {
        return Math.floor((validLen + placeHoldersLen) * 3 / 4 - placeHoldersLen);
    }
    function tripletToBase64(num) {
        return lookup[num >> 18 & 0x3f] + lookup[num >> 12 & 0x3f] + lookup[num >> 6 & 0x3f] + lookup[num & 0x3f];
    }
    function encodeChunk(buf, start, end) {
        const out = new Array((end - start) / 3);
        for(let i = start, curTriplet = 0; i < end; i += 3){
            out[curTriplet++] = tripletToBase64((buf[i] << 16) + (buf[i + 1] << 8) + buf[i + 2]);
        }
        return out.join("");
    }
    return {
        // base64 is 4/3 + up to two characters of the original data
        byteLength (b64) {
            return _byteLength.apply(null, getLengths(b64));
        },
        toUint8Array (b64) {
            const [validLen, placeHoldersLen] = getLengths(b64);
            const buf = new Uint8Array(_byteLength(validLen, placeHoldersLen));
            // If there are placeholders, only get up to the last complete 4 chars
            const len = placeHoldersLen ? validLen - 4 : validLen;
            let tmp;
            let curByte = 0;
            let i;
            for(i = 0; i < len; i += 4){
                tmp = revLookup[b64.charCodeAt(i)] << 18 | revLookup[b64.charCodeAt(i + 1)] << 12 | revLookup[b64.charCodeAt(i + 2)] << 6 | revLookup[b64.charCodeAt(i + 3)];
                buf[curByte++] = tmp >> 16 & 0xff;
                buf[curByte++] = tmp >> 8 & 0xff;
                buf[curByte++] = tmp & 0xff;
            }
            if (placeHoldersLen === 2) {
                tmp = revLookup[b64.charCodeAt(i)] << 2 | revLookup[b64.charCodeAt(i + 1)] >> 4;
                buf[curByte++] = tmp & 0xff;
            } else if (placeHoldersLen === 1) {
                tmp = revLookup[b64.charCodeAt(i)] << 10 | revLookup[b64.charCodeAt(i + 1)] << 4 | revLookup[b64.charCodeAt(i + 2)] >> 2;
                buf[curByte++] = tmp >> 8 & 0xff;
                buf[curByte++] = tmp & 0xff;
            }
            return buf;
        },
        fromUint8Array (buf) {
            const maxChunkLength = 16383; // Must be multiple of 3
            const len = buf.length;
            const extraBytes = len % 3; // If we have 1 byte left, pad 2 bytes
            const len2 = len - extraBytes;
            const parts = new Array(Math.ceil(len2 / maxChunkLength) + (extraBytes ? 1 : 0));
            let curChunk = 0;
            let chunkEnd;
            // Go through the array every three bytes, we'll deal with trailing stuff later
            for(let i = 0; i < len2; i += maxChunkLength){
                chunkEnd = i + maxChunkLength;
                parts[curChunk++] = encodeChunk(buf, i, chunkEnd > len2 ? len2 : chunkEnd);
            }
            let tmp;
            // Pad the end with zeros, but make sure to not forget the extra bytes
            if (extraBytes === 1) {
                tmp = buf[len2];
                parts[curChunk] = lookup[tmp >> 2] + lookup[tmp << 4 & 0x3f];
                if (!urlsafe) parts[curChunk] += "==";
            } else if (extraBytes === 2) {
                tmp = buf[len2] << 8 | buf[len2 + 1] & 0xff;
                parts[curChunk] = lookup[tmp >> 10] + lookup[tmp >> 4 & 0x3f] + lookup[tmp << 2 & 0x3f];
                if (!urlsafe) parts[curChunk] += "=";
            }
            return parts.join("");
        }
    };
}

;// CONCATENATED MODULE: ./node_modules/.pnpm/@upstash+redis@1.21.0/node_modules/@upstash/redis/esm/deps/deno.land/x/base64@v0.2.1/base64url.js

const lookup = [];
const revLookup = [];
const code = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
for(let i = 0, l = code.length; i < l; ++i){
    lookup[i] = code[i];
    revLookup[code.charCodeAt(i)] = i;
}
const { byteLength, toUint8Array, fromUint8Array } = init(lookup, revLookup, true);

;// CONCATENATED MODULE: ./node_modules/.pnpm/@upstash+redis@1.21.0/node_modules/@upstash/redis/esm/deps/denopkg.com/chiefbiiko/std-encoding@v1.0.0/mod.js

const decoder = new TextDecoder();
const encoder = new TextEncoder();
/** Serializes a Uint8Array to a hexadecimal string. */ function toHexString(buf) {
    return buf.reduce((hex, byte)=>`${hex}${byte < 16 ? "0" : ""}${byte.toString(16)}`, "");
}
/** Deserializes a Uint8Array from a hexadecimal string. */ function fromHexString(hex) {
    const len = hex.length;
    if (len % 2 || !/^[0-9a-fA-F]+$/.test(hex)) {
        throw new TypeError("Invalid hex string.");
    }
    hex = hex.toLowerCase();
    const buf = new Uint8Array(Math.floor(len / 2));
    const end = len / 2;
    for(let i = 0; i < end; ++i){
        buf[i] = parseInt(hex.substr(i * 2, 2), 16);
    }
    return buf;
}
/** Decodes a Uint8Array to utf8-, base64-, or hex-encoded string. */ function decode(buf, encoding = "utf8") {
    if (/^utf-?8$/i.test(encoding)) {
        return decoder.decode(buf);
    } else if (/^base64$/i.test(encoding)) {
        return fromUint8Array(buf);
    } else if (/^hex(?:adecimal)?$/i.test(encoding)) {
        return toHexString(buf);
    } else {
        throw new TypeError("Unsupported string encoding.");
    }
}
function encode(str, encoding = "utf8") {
    if (/^utf-?8$/i.test(encoding)) {
        return encoder.encode(str);
    } else if (/^base64$/i.test(encoding)) {
        return toUint8Array(str);
    } else if (/^hex(?:adecimal)?$/i.test(encoding)) {
        return fromHexString(str);
    } else {
        throw new TypeError("Unsupported string encoding.");
    }
}

;// CONCATENATED MODULE: ./node_modules/.pnpm/@upstash+redis@1.21.0/node_modules/@upstash/redis/esm/deps/deno.land/x/sha1@v1.0.3/deps.js


;// CONCATENATED MODULE: ./node_modules/.pnpm/@upstash+redis@1.21.0/node_modules/@upstash/redis/esm/deps/deno.land/x/sha1@v1.0.3/mod.js

function rotl(x, n) {
    return x << n | x >>> 32 - n;
}
/** Byte length of a SHA1 digest. */ const BYTES = 20;
/**  A class representation of the SHA1 algorithm. */ class SHA1 {
    /** Creates a SHA1 instance. */ constructor(){
        Object.defineProperty(this, "hashSize", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: BYTES
        });
        Object.defineProperty(this, "_buf", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: new Uint8Array(64)
        });
        Object.defineProperty(this, "_bufIdx", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        Object.defineProperty(this, "_count", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        Object.defineProperty(this, "_K", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: new Uint32Array([
                0x5a827999,
                0x6ed9eba1,
                0x8f1bbcdc,
                0xca62c1d6
            ])
        });
        Object.defineProperty(this, "_H", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        Object.defineProperty(this, "_finalized", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        this.init();
    }
    /** Reduces the four input numbers to a single one. */ static F(t, b, c, d) {
        if (t <= 19) {
            return b & c | ~b & d;
        } else if (t <= 39) {
            return b ^ c ^ d;
        } else if (t <= 59) {
            return b & c | b & d | c & d;
        } else {
            return b ^ c ^ d;
        }
    }
    /** Initializes a hash instance. */ init() {
        // prettier-ignore
        this._H = new Uint32Array([
            0x67452301,
            0xEFCDAB89,
            0x98BADCFE,
            0x10325476,
            0xC3D2E1F0
        ]);
        this._bufIdx = 0;
        this._count = new Uint32Array(2);
        this._buf.fill(0);
        this._finalized = false;
        return this;
    }
    /** Updates a hash with additional message data. */ update(msg, inputEncoding) {
        if (msg === null) {
            throw new TypeError("msg must be a string or Uint8Array.");
        } else if (typeof msg === "string") {
            msg = encode(msg, inputEncoding);
        }
        // process the msg as many times as possible, the rest is stored in the buffer
        // message is processed in 512 bit (64 byte chunks)
        for(let i = 0; i < msg.length; i++){
            this._buf[this._bufIdx++] = msg[i];
            if (this._bufIdx === 64) {
                this.transform();
                this._bufIdx = 0;
            }
        }
        // counter update (number of message bits)
        const c = this._count;
        if ((c[0] += msg.length << 3) < msg.length << 3) {
            c[1]++;
        }
        c[1] += msg.length >>> 29;
        return this;
    }
    /** Finalizes a hash with additional message data. */ digest(outputEncoding) {
        if (this._finalized) {
            throw new Error("digest has already been called.");
        }
        this._finalized = true;
        // append '1'
        const b = this._buf;
        let idx = this._bufIdx;
        b[idx++] = 0x80;
        // zeropad up to byte pos 56
        while(idx !== 56){
            if (idx === 64) {
                this.transform();
                idx = 0;
            }
            b[idx++] = 0;
        }
        // append length in bits
        const c = this._count;
        b[56] = c[1] >>> 24 & 0xff;
        b[57] = c[1] >>> 16 & 0xff;
        b[58] = c[1] >>> 8 & 0xff;
        b[59] = c[1] >>> 0 & 0xff;
        b[60] = c[0] >>> 24 & 0xff;
        b[61] = c[0] >>> 16 & 0xff;
        b[62] = c[0] >>> 8 & 0xff;
        b[63] = c[0] >>> 0 & 0xff;
        this.transform();
        // return the hash as byte array (20 bytes)
        const hash = new Uint8Array(BYTES);
        for(let i = 0; i < 5; i++){
            hash[(i << 2) + 0] = this._H[i] >>> 24 & 0xff;
            hash[(i << 2) + 1] = this._H[i] >>> 16 & 0xff;
            hash[(i << 2) + 2] = this._H[i] >>> 8 & 0xff;
            hash[(i << 2) + 3] = this._H[i] >>> 0 & 0xff;
        }
        // clear internal states and prepare for new hash
        this.init();
        return outputEncoding ? decode(hash, outputEncoding) : hash;
    }
    /** Performs one transformation cycle. */ transform() {
        const h = this._H;
        let a = h[0];
        let b = h[1];
        let c = h[2];
        let d = h[3];
        let e = h[4];
        // convert byte buffer to words
        const w = new Uint32Array(80);
        for(let i = 0; i < 16; i++){
            w[i] = this._buf[(i << 2) + 3] | this._buf[(i << 2) + 2] << 8 | this._buf[(i << 2) + 1] << 16 | this._buf[i << 2] << 24;
        }
        for(let t = 0; t < 80; t++){
            if (t >= 16) {
                w[t] = rotl(w[t - 3] ^ w[t - 8] ^ w[t - 14] ^ w[t - 16], 1);
            }
            const tmp = rotl(a, 5) + SHA1.F(t, b, c, d) + e + w[t] + this._K[Math.floor(t / 20)] | 0;
            e = d;
            d = c;
            c = rotl(b, 30);
            b = a;
            a = tmp;
        }
        h[0] = h[0] + a | 0;
        h[1] = h[1] + b | 0;
        h[2] = h[2] + c | 0;
        h[3] = h[3] + d | 0;
        h[4] = h[4] + e | 0;
    }
}
/** Generates a SHA1 hash of the input data. */ function sha1(msg, inputEncoding, outputEncoding) {
    return new SHA1().update(msg, inputEncoding).digest(outputEncoding);
}

;// CONCATENATED MODULE: ./node_modules/.pnpm/@upstash+redis@1.21.0/node_modules/@upstash/redis/esm/pkg/script.js

/**
 * Creates a new script.
 *
 * Scripts offer the ability to optimistically try to execute a script without having to send the
 * entire script to the server. If the script is loaded on the server, it tries again by sending
 * the entire script. Afterwards, the script is cached on the server.
 *
 * @example
 * ```ts
 * const redis = new Redis({...})
 *
 * const script = redis.createScript<string>("return ARGV[1];")
 * const arg1 = await script.eval([], ["Hello World"])
 * assertEquals(arg1, "Hello World")
 * ```
 */ class Script {
    constructor(redis, script){
        Object.defineProperty(this, "script", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        Object.defineProperty(this, "sha1", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        Object.defineProperty(this, "redis", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        this.redis = redis;
        this.sha1 = this.digest(script);
        this.script = script;
    }
    /**
     * Send an `EVAL` command to redis.
     */ async eval(keys, args) {
        return await this.redis.eval(this.script, keys, args);
    }
    /**
     * Calculates the sha1 hash of the script and then calls `EVALSHA`.
     */ async evalsha(keys, args) {
        return await this.redis.evalsha(this.sha1, keys, args);
    }
    /**
     * Optimistically try to run `EVALSHA` first.
     * If the script is not loaded in redis, it will fall back and try again with `EVAL`.
     *
     * Following calls will be able to use the cached script
     */ async exec(keys, args) {
        const res = await this.redis.evalsha(this.sha1, keys, args).catch(async (err)=>{
            if (err instanceof Error && err.message.toLowerCase().includes("noscript")) {
                return await this.redis.eval(this.script, keys, args);
            }
            throw err;
        });
        return res;
    }
    /**
     * Compute the sha1 hash of the script and return its hex representation.
     */ digest(s) {
        const hash = sha1(s, "utf8", "hex");
        return typeof hash === "string" ? hash : new TextDecoder().decode(hash);
    }
}

;// CONCATENATED MODULE: ./node_modules/.pnpm/@upstash+redis@1.21.0/node_modules/@upstash/redis/esm/pkg/redis.js





/**
 * Serverless redis client for upstash.
 */ class redis_Redis {
    /**
     * Create a new redis client
     *
     * @example
     * ```typescript
     * const redis = new Redis({
     *  url: "<UPSTASH_REDIS_REST_URL>",
     *  token: "<UPSTASH_REDIS_REST_TOKEN>",
     * });
     * ```
     */ constructor(client, opts){
        Object.defineProperty(this, "client", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        Object.defineProperty(this, "opts", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        Object.defineProperty(this, "enableTelemetry", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        /**
         * Wrap a new middleware around the HTTP client.
         */ Object.defineProperty(this, "use", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (middleware)=>{
                const makeRequest = this.client.request.bind(this.client);
                this.client.request = (req)=>middleware(req, makeRequest);
            }
        });
        /**
         * Technically this is not private, we can hide it from intellisense by doing this
         */ Object.defineProperty(this, "addTelemetry", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (telemetry)=>{
                if (!this.enableTelemetry) {
                    return;
                }
                try {
                    // @ts-ignore - The `Requester` interface does not know about this method but it will be there
                    // as long as the user uses the standard HttpClient
                    this.client.mergeTelemetry(telemetry);
                } catch  {
                // ignore
                }
            }
        });
        /**
         * Create a new pipeline that allows you to send requests in bulk.
         *
         * @see {@link Pipeline}
         */ Object.defineProperty(this, "pipeline", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: ()=>new Pipeline({
                    client: this.client,
                    commandOptions: this.opts,
                    multiExec: false
                })
        });
        /**
         * Create a new transaction to allow executing multiple steps atomically.
         *
         * All the commands in a transaction are serialized and executed sequentially. A request sent by
         * another client will never be served in the middle of the execution of a Redis Transaction. This
         * guarantees that the commands are executed as a single isolated operation.
         *
         * @see {@link Pipeline}
         */ Object.defineProperty(this, "multi", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: ()=>new Pipeline({
                    client: this.client,
                    commandOptions: this.opts,
                    multiExec: true
                })
        });
        /**
         * @see https://redis.io/commands/append
         */ Object.defineProperty(this, "append", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (...args)=>new AppendCommand(args, this.opts).exec(this.client)
        });
        /**
         * @see https://redis.io/commands/bitcount
         */ Object.defineProperty(this, "bitcount", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (...args)=>new BitCountCommand(args, this.opts).exec(this.client)
        });
        /**
         * @see https://redis.io/commands/bitop
         */ Object.defineProperty(this, "bitop", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (op, destinationKey, sourceKey, ...sourceKeys)=>new BitOpCommand([
                    op,
                    destinationKey,
                    sourceKey,
                    ...sourceKeys
                ], this.opts).exec(this.client)
        });
        /**
         * @see https://redis.io/commands/bitpos
         */ Object.defineProperty(this, "bitpos", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (...args)=>new BitPosCommand(args, this.opts).exec(this.client)
        });
        /**
         * @see https://redis.io/commands/dbsize
         */ Object.defineProperty(this, "dbsize", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: ()=>new DBSizeCommand(this.opts).exec(this.client)
        });
        /**
         * @see https://redis.io/commands/decr
         */ Object.defineProperty(this, "decr", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (...args)=>new DecrCommand(args, this.opts).exec(this.client)
        });
        /**
         * @see https://redis.io/commands/decrby
         */ Object.defineProperty(this, "decrby", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (...args)=>new DecrByCommand(args, this.opts).exec(this.client)
        });
        /**
         * @see https://redis.io/commands/del
         */ Object.defineProperty(this, "del", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (...args)=>new DelCommand(args, this.opts).exec(this.client)
        });
        /**
         * @see https://redis.io/commands/echo
         */ Object.defineProperty(this, "echo", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (...args)=>new EchoCommand(args, this.opts).exec(this.client)
        });
        /**
         * @see https://redis.io/commands/eval
         */ Object.defineProperty(this, "eval", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (...args)=>new EvalCommand(args, this.opts).exec(this.client)
        });
        /**
         * @see https://redis.io/commands/evalsha
         */ Object.defineProperty(this, "evalsha", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (...args)=>new EvalshaCommand(args, this.opts).exec(this.client)
        });
        /**
         * @see https://redis.io/commands/exists
         */ Object.defineProperty(this, "exists", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (...args)=>new ExistsCommand(args, this.opts).exec(this.client)
        });
        /**
         * @see https://redis.io/commands/expire
         */ Object.defineProperty(this, "expire", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (...args)=>new ExpireCommand(args, this.opts).exec(this.client)
        });
        /**
         * @see https://redis.io/commands/expireat
         */ Object.defineProperty(this, "expireat", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (...args)=>new ExpireAtCommand(args, this.opts).exec(this.client)
        });
        /**
         * @see https://redis.io/commands/flushall
         */ Object.defineProperty(this, "flushall", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (args)=>new FlushAllCommand(args, this.opts).exec(this.client)
        });
        /**
         * @see https://redis.io/commands/flushdb
         */ Object.defineProperty(this, "flushdb", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (...args)=>new FlushDBCommand(args, this.opts).exec(this.client)
        });
        /**
         * @see https://redis.io/commands/get
         */ Object.defineProperty(this, "get", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (...args)=>new GetCommand(args, this.opts).exec(this.client)
        });
        /**
         * @see https://redis.io/commands/getbit
         */ Object.defineProperty(this, "getbit", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (...args)=>new GetBitCommand(args, this.opts).exec(this.client)
        });
        /**
         * @see https://redis.io/commands/getdel
         */ Object.defineProperty(this, "getdel", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (...args)=>new GetDelCommand(args, this.opts).exec(this.client)
        });
        /**
         * @see https://redis.io/commands/getrange
         */ Object.defineProperty(this, "getrange", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (...args)=>new GetRangeCommand(args, this.opts).exec(this.client)
        });
        /**
         * @see https://redis.io/commands/getset
         */ Object.defineProperty(this, "getset", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (key, value)=>new GetSetCommand([
                    key,
                    value
                ], this.opts).exec(this.client)
        });
        /**
         * @see https://redis.io/commands/hdel
         */ Object.defineProperty(this, "hdel", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (...args)=>new HDelCommand(args, this.opts).exec(this.client)
        });
        /**
         * @see https://redis.io/commands/hexists
         */ Object.defineProperty(this, "hexists", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (...args)=>new HExistsCommand(args, this.opts).exec(this.client)
        });
        /**
         * @see https://redis.io/commands/hget
         */ Object.defineProperty(this, "hget", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (...args)=>new HGetCommand(args, this.opts).exec(this.client)
        });
        /**
         * @see https://redis.io/commands/hgetall
         */ Object.defineProperty(this, "hgetall", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (...args)=>new HGetAllCommand(args, this.opts).exec(this.client)
        });
        /**
         * @see https://redis.io/commands/hincrby
         */ Object.defineProperty(this, "hincrby", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (...args)=>new HIncrByCommand(args, this.opts).exec(this.client)
        });
        /**
         * @see https://redis.io/commands/hincrbyfloat
         */ Object.defineProperty(this, "hincrbyfloat", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (...args)=>new HIncrByFloatCommand(args, this.opts).exec(this.client)
        });
        /**
         * @see https://redis.io/commands/hkeys
         */ Object.defineProperty(this, "hkeys", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (...args)=>new HKeysCommand(args, this.opts).exec(this.client)
        });
        /**
         * @see https://redis.io/commands/hlen
         */ Object.defineProperty(this, "hlen", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (...args)=>new HLenCommand(args, this.opts).exec(this.client)
        });
        /**
         * @see https://redis.io/commands/hmget
         */ Object.defineProperty(this, "hmget", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (...args)=>new HMGetCommand(args, this.opts).exec(this.client)
        });
        /**
         * @see https://redis.io/commands/hmset
         */ Object.defineProperty(this, "hmset", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (key, kv)=>new HMSetCommand([
                    key,
                    kv
                ], this.opts).exec(this.client)
        });
        /**
         * @see https://redis.io/commands/hrandfield
         */ Object.defineProperty(this, "hrandfield", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (key, count, withValues)=>new HRandFieldCommand([
                    key,
                    count,
                    withValues
                ], this.opts).exec(this.client)
        });
        /**
         * @see https://redis.io/commands/hscan
         */ Object.defineProperty(this, "hscan", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (...args)=>new HScanCommand(args, this.opts).exec(this.client)
        });
        /**
         * @see https://redis.io/commands/hset
         */ Object.defineProperty(this, "hset", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (key, kv)=>new HSetCommand([
                    key,
                    kv
                ], this.opts).exec(this.client)
        });
        /**
         * @see https://redis.io/commands/hsetnx
         */ Object.defineProperty(this, "hsetnx", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (key, field, value)=>new HSetNXCommand([
                    key,
                    field,
                    value
                ], this.opts).exec(this.client)
        });
        /**
         * @see https://redis.io/commands/hstrlen
         */ Object.defineProperty(this, "hstrlen", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (...args)=>new HStrLenCommand(args, this.opts).exec(this.client)
        });
        /**
         * @see https://redis.io/commands/hvals
         */ Object.defineProperty(this, "hvals", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (...args)=>new HValsCommand(args, this.opts).exec(this.client)
        });
        /**
         * @see https://redis.io/commands/incr
         */ Object.defineProperty(this, "incr", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (...args)=>new IncrCommand(args, this.opts).exec(this.client)
        });
        /**
         * @see https://redis.io/commands/incrby
         */ Object.defineProperty(this, "incrby", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (...args)=>new IncrByCommand(args, this.opts).exec(this.client)
        });
        /**
         * @see https://redis.io/commands/incrbyfloat
         */ Object.defineProperty(this, "incrbyfloat", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (...args)=>new IncrByFloatCommand(args, this.opts).exec(this.client)
        });
        /**
         * @see https://redis.io/commands/keys
         */ Object.defineProperty(this, "keys", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (...args)=>new KeysCommand(args, this.opts).exec(this.client)
        });
        /**
         * @see https://redis.io/commands/lindex
         */ Object.defineProperty(this, "lindex", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (...args)=>new LIndexCommand(args, this.opts).exec(this.client)
        });
        /**
         * @see https://redis.io/commands/linsert
         */ Object.defineProperty(this, "linsert", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (key, direction, pivot, value)=>new LInsertCommand([
                    key,
                    direction,
                    pivot,
                    value
                ], this.opts).exec(this.client)
        });
        /**
         * @see https://redis.io/commands/llen
         */ Object.defineProperty(this, "llen", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (...args)=>new LLenCommand(args, this.opts).exec(this.client)
        });
        /**
         * @see https://redis.io/commands/lmove
         */ Object.defineProperty(this, "lmove", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (...args)=>new LMoveCommand(args, this.opts).exec(this.client)
        });
        /**
         * @see https://redis.io/commands/lpop
         */ Object.defineProperty(this, "lpop", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (...args)=>new LPopCommand(args, this.opts).exec(this.client)
        });
        /**
         * @see https://redis.io/commands/lpos
         */ Object.defineProperty(this, "lpos", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (...args)=>new LPosCommand(args, this.opts).exec(this.client)
        });
        /**
         * @see https://redis.io/commands/lpush
         */ Object.defineProperty(this, "lpush", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (key, ...elements)=>new LPushCommand([
                    key,
                    ...elements
                ], this.opts).exec(this.client)
        });
        /**
         * @see https://redis.io/commands/lpushx
         */ Object.defineProperty(this, "lpushx", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (key, ...elements)=>new LPushXCommand([
                    key,
                    ...elements
                ], this.opts).exec(this.client)
        });
        /**
         * @see https://redis.io/commands/lrange
         */ Object.defineProperty(this, "lrange", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (...args)=>new LRangeCommand(args, this.opts).exec(this.client)
        });
        /**
         * @see https://redis.io/commands/lrem
         */ Object.defineProperty(this, "lrem", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (key, count, value)=>new LRemCommand([
                    key,
                    count,
                    value
                ], this.opts).exec(this.client)
        });
        /**
         * @see https://redis.io/commands/lset
         */ Object.defineProperty(this, "lset", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (key, index, value)=>new LSetCommand([
                    key,
                    index,
                    value
                ], this.opts).exec(this.client)
        });
        /**
         * @see https://redis.io/commands/ltrim
         */ Object.defineProperty(this, "ltrim", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (...args)=>new LTrimCommand(args, this.opts).exec(this.client)
        });
        /**
         * @see https://redis.io/commands/mget
         */ Object.defineProperty(this, "mget", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (...args)=>new MGetCommand(args, this.opts).exec(this.client)
        });
        /**
         * @see https://redis.io/commands/mset
         */ Object.defineProperty(this, "mset", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (kv)=>new MSetCommand([
                    kv
                ], this.opts).exec(this.client)
        });
        /**
         * @see https://redis.io/commands/msetnx
         */ Object.defineProperty(this, "msetnx", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (kv)=>new MSetNXCommand([
                    kv
                ], this.opts).exec(this.client)
        });
        /**
         * @see https://redis.io/commands/persist
         */ Object.defineProperty(this, "persist", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (...args)=>new PersistCommand(args, this.opts).exec(this.client)
        });
        /**
         * @see https://redis.io/commands/pexpire
         */ Object.defineProperty(this, "pexpire", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (...args)=>new PExpireCommand(args, this.opts).exec(this.client)
        });
        /**
         * @see https://redis.io/commands/pexpireat
         */ Object.defineProperty(this, "pexpireat", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (...args)=>new PExpireAtCommand(args, this.opts).exec(this.client)
        });
        /**
         * @see https://redis.io/commands/ping
         */ Object.defineProperty(this, "ping", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (args)=>new PingCommand(args, this.opts).exec(this.client)
        });
        /**
         * @see https://redis.io/commands/psetex
         */ Object.defineProperty(this, "psetex", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (key, ttl, value)=>new PSetEXCommand([
                    key,
                    ttl,
                    value
                ], this.opts).exec(this.client)
        });
        /**
         * @see https://redis.io/commands/pttl
         */ Object.defineProperty(this, "pttl", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (...args)=>new PTtlCommand(args, this.opts).exec(this.client)
        });
        /**
         * @see https://redis.io/commands/publish
         */ Object.defineProperty(this, "publish", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (...args)=>new PublishCommand(args, this.opts).exec(this.client)
        });
        /**
         * @see https://redis.io/commands/randomkey
         */ Object.defineProperty(this, "randomkey", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: ()=>new RandomKeyCommand().exec(this.client)
        });
        /**
         * @see https://redis.io/commands/rename
         */ Object.defineProperty(this, "rename", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (...args)=>new RenameCommand(args, this.opts).exec(this.client)
        });
        /**
         * @see https://redis.io/commands/renamenx
         */ Object.defineProperty(this, "renamenx", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (...args)=>new RenameNXCommand(args, this.opts).exec(this.client)
        });
        /**
         * @see https://redis.io/commands/rpop
         */ Object.defineProperty(this, "rpop", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (...args)=>new RPopCommand(args, this.opts).exec(this.client)
        });
        /**
         * @see https://redis.io/commands/rpush
         */ Object.defineProperty(this, "rpush", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (key, ...elements)=>new RPushCommand([
                    key,
                    ...elements
                ], this.opts).exec(this.client)
        });
        /**
         * @see https://redis.io/commands/rpushx
         */ Object.defineProperty(this, "rpushx", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (key, ...elements)=>new RPushXCommand([
                    key,
                    ...elements
                ], this.opts).exec(this.client)
        });
        /**
         * @see https://redis.io/commands/sadd
         */ Object.defineProperty(this, "sadd", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (key, ...members)=>new SAddCommand([
                    key,
                    ...members
                ], this.opts).exec(this.client)
        });
        /**
         * @see https://redis.io/commands/scan
         */ Object.defineProperty(this, "scan", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (...args)=>new ScanCommand(args, this.opts).exec(this.client)
        });
        /**
         * @see https://redis.io/commands/scard
         */ Object.defineProperty(this, "scard", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (...args)=>new SCardCommand(args, this.opts).exec(this.client)
        });
        /**
         * @see https://redis.io/commands/script-exists
         */ Object.defineProperty(this, "scriptExists", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (...args)=>new ScriptExistsCommand(args, this.opts).exec(this.client)
        });
        /**
         * @see https://redis.io/commands/script-flush
         */ Object.defineProperty(this, "scriptFlush", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (...args)=>new ScriptFlushCommand(args, this.opts).exec(this.client)
        });
        /**
         * @see https://redis.io/commands/script-load
         */ Object.defineProperty(this, "scriptLoad", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (...args)=>new ScriptLoadCommand(args, this.opts).exec(this.client)
        });
        /**
         * @see https://redis.io/commands/sdiff
         */ Object.defineProperty(this, "sdiff", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (...args)=>new SDiffCommand(args, this.opts).exec(this.client)
        });
        /**
         * @see https://redis.io/commands/sdiffstore
         */ Object.defineProperty(this, "sdiffstore", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (...args)=>new SDiffStoreCommand(args, this.opts).exec(this.client)
        });
        /**
         * @see https://redis.io/commands/set
         */ Object.defineProperty(this, "set", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (key, value, opts)=>new SetCommand([
                    key,
                    value,
                    opts
                ], this.opts).exec(this.client)
        });
        /**
         * @see https://redis.io/commands/setbit
         */ Object.defineProperty(this, "setbit", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (...args)=>new SetBitCommand(args, this.opts).exec(this.client)
        });
        /**
         * @see https://redis.io/commands/setex
         */ Object.defineProperty(this, "setex", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (key, ttl, value)=>new SetExCommand([
                    key,
                    ttl,
                    value
                ], this.opts).exec(this.client)
        });
        /**
         * @see https://redis.io/commands/setnx
         */ Object.defineProperty(this, "setnx", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (key, value)=>new SetNxCommand([
                    key,
                    value
                ], this.opts).exec(this.client)
        });
        /**
         * @see https://redis.io/commands/setrange
         */ Object.defineProperty(this, "setrange", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (...args)=>new SetRangeCommand(args, this.opts).exec(this.client)
        });
        /**
         * @see https://redis.io/commands/sinter
         */ Object.defineProperty(this, "sinter", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (...args)=>new SInterCommand(args, this.opts).exec(this.client)
        });
        /**
         * @see https://redis.io/commands/sinterstore
         */ Object.defineProperty(this, "sinterstore", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (...args)=>new SInterStoreCommand(args, this.opts).exec(this.client)
        });
        /**
         * @see https://redis.io/commands/sismember
         */ Object.defineProperty(this, "sismember", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (key, member)=>new SIsMemberCommand([
                    key,
                    member
                ], this.opts).exec(this.client)
        });
        /**
         * @see https://redis.io/commands/smismember
         */ Object.defineProperty(this, "smismember", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (key, members)=>new SMIsMemberCommand([
                    key,
                    members
                ], this.opts).exec(this.client)
        });
        /**
         * @see https://redis.io/commands/smembers
         */ Object.defineProperty(this, "smembers", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (...args)=>new SMembersCommand(args, this.opts).exec(this.client)
        });
        /**
         * @see https://redis.io/commands/smove
         */ Object.defineProperty(this, "smove", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (source, destination, member)=>new SMoveCommand([
                    source,
                    destination,
                    member
                ], this.opts).exec(this.client)
        });
        /**
         * @see https://redis.io/commands/spop
         */ Object.defineProperty(this, "spop", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (...args)=>new SPopCommand(args, this.opts).exec(this.client)
        });
        /**
         * @see https://redis.io/commands/srandmember
         */ Object.defineProperty(this, "srandmember", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (...args)=>new SRandMemberCommand(args, this.opts).exec(this.client)
        });
        /**
         * @see https://redis.io/commands/srem
         */ Object.defineProperty(this, "srem", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (key, ...members)=>new SRemCommand([
                    key,
                    ...members
                ], this.opts).exec(this.client)
        });
        /**
         * @see https://redis.io/commands/sscan
         */ Object.defineProperty(this, "sscan", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (...args)=>new SScanCommand(args, this.opts).exec(this.client)
        });
        /**
         * @see https://redis.io/commands/strlen
         */ Object.defineProperty(this, "strlen", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (...args)=>new StrLenCommand(args, this.opts).exec(this.client)
        });
        /**
         * @see https://redis.io/commands/sunion
         */ Object.defineProperty(this, "sunion", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (...args)=>new SUnionCommand(args, this.opts).exec(this.client)
        });
        /**
         * @see https://redis.io/commands/sunionstore
         */ Object.defineProperty(this, "sunionstore", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (...args)=>new SUnionStoreCommand(args, this.opts).exec(this.client)
        });
        /**
         * @see https://redis.io/commands/time
         */ Object.defineProperty(this, "time", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: ()=>new TimeCommand().exec(this.client)
        });
        /**
         * @see https://redis.io/commands/touch
         */ Object.defineProperty(this, "touch", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (...args)=>new TouchCommand(args, this.opts).exec(this.client)
        });
        /**
         * @see https://redis.io/commands/ttl
         */ Object.defineProperty(this, "ttl", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (...args)=>new TtlCommand(args, this.opts).exec(this.client)
        });
        /**
         * @see https://redis.io/commands/type
         */ Object.defineProperty(this, "type", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (...args)=>new TypeCommand(args, this.opts).exec(this.client)
        });
        /**
         * @see https://redis.io/commands/unlink
         */ Object.defineProperty(this, "unlink", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (...args)=>new UnlinkCommand(args, this.opts).exec(this.client)
        });
        /**
         * @see https://redis.io/commands/zadd
         */ Object.defineProperty(this, "zadd", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (...args)=>{
                if ("score" in args[1]) {
                    return new ZAddCommand([
                        args[0],
                        args[1],
                        ...args.slice(2)
                    ], this.opts).exec(this.client);
                }
                return new ZAddCommand([
                    args[0],
                    args[1],
                    ...args.slice(2)
                ], this.opts).exec(this.client);
            }
        });
        /**
         * @see https://redis.io/commands/zcard
         */ Object.defineProperty(this, "zcard", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (...args)=>new ZCardCommand(args, this.opts).exec(this.client)
        });
        /**
         * @see https://redis.io/commands/zcount
         */ Object.defineProperty(this, "zcount", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (...args)=>new ZCountCommand(args, this.opts).exec(this.client)
        });
        /**
         * @see https://redis.io/commands/zdiffstore
         */ Object.defineProperty(this, "zdiffstore", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (...args)=>new ZDiffStoreCommand(args, this.opts).exec(this.client)
        });
        /**
         * @see https://redis.io/commands/zincrby
         */ Object.defineProperty(this, "zincrby", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (key, increment, member)=>new ZIncrByCommand([
                    key,
                    increment,
                    member
                ], this.opts).exec(this.client)
        });
        /**
         * @see https://redis.io/commands/zinterstore
         */ Object.defineProperty(this, "zinterstore", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (...args)=>new ZInterStoreCommand(args, this.opts).exec(this.client)
        });
        /**
         * @see https://redis.io/commands/zlexcount
         */ Object.defineProperty(this, "zlexcount", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (...args)=>new ZLexCountCommand(args, this.opts).exec(this.client)
        });
        /**
         * @see https://redis.io/commands/zmscore
         */ Object.defineProperty(this, "zmscore", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (...args)=>new ZMScoreCommand(args, this.opts).exec(this.client)
        });
        /**
         * @see https://redis.io/commands/zpopmax
         */ Object.defineProperty(this, "zpopmax", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (...args)=>new ZPopMaxCommand(args, this.opts).exec(this.client)
        });
        /**
         * @see https://redis.io/commands/zpopmin
         */ Object.defineProperty(this, "zpopmin", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (...args)=>new ZPopMinCommand(args, this.opts).exec(this.client)
        });
        /**
         * @see https://redis.io/commands/zrange
         */ Object.defineProperty(this, "zrange", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (...args)=>new ZRangeCommand(args, this.opts).exec(this.client)
        });
        /**
         * @see https://redis.io/commands/zrank
         */ Object.defineProperty(this, "zrank", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (key, member)=>new ZRankCommand([
                    key,
                    member
                ], this.opts).exec(this.client)
        });
        /**
         * @see https://redis.io/commands/zrem
         */ Object.defineProperty(this, "zrem", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (key, ...members)=>new ZRemCommand([
                    key,
                    ...members
                ], this.opts).exec(this.client)
        });
        /**
         * @see https://redis.io/commands/zremrangebylex
         */ Object.defineProperty(this, "zremrangebylex", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (...args)=>new ZRemRangeByLexCommand(args, this.opts).exec(this.client)
        });
        /**
         * @see https://redis.io/commands/zremrangebyrank
         */ Object.defineProperty(this, "zremrangebyrank", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (...args)=>new ZRemRangeByRankCommand(args, this.opts).exec(this.client)
        });
        /**
         * @see https://redis.io/commands/zremrangebyscore
         */ Object.defineProperty(this, "zremrangebyscore", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (...args)=>new ZRemRangeByScoreCommand(args, this.opts).exec(this.client)
        });
        /**
         * @see https://redis.io/commands/zrevrank
         */ Object.defineProperty(this, "zrevrank", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (key, member)=>new ZRevRankCommand([
                    key,
                    member
                ], this.opts).exec(this.client)
        });
        /**
         * @see https://redis.io/commands/zscan
         */ Object.defineProperty(this, "zscan", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (...args)=>new ZScanCommand(args, this.opts).exec(this.client)
        });
        /**
         * @see https://redis.io/commands/zscore
         */ Object.defineProperty(this, "zscore", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (key, member)=>new ZScoreCommand([
                    key,
                    member
                ], this.opts).exec(this.client)
        });
        /**
         * @see https://redis.io/commands/zunionstore
         */ Object.defineProperty(this, "zunionstore", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: (...args)=>new ZUnionStoreCommand(args, this.opts).exec(this.client)
        });
        this.client = client;
        this.opts = opts;
        this.enableTelemetry = opts?.enableTelemetry ?? true;
    }
    get json() {
        return {
            /**
             * @see https://redis.io/commands/json.arrappend
             */ arrappend: (...args)=>new JsonArrAppendCommand(args, this.opts).exec(this.client),
            /**
             * @see https://redis.io/commands/json.arrindex
             */ arrindex: (...args)=>new JsonArrIndexCommand(args, this.opts).exec(this.client),
            /**
             * @see https://redis.io/commands/json.arrinsert
             */ arrinsert: (...args)=>new JsonArrInsertCommand(args, this.opts).exec(this.client),
            /**
             * @see https://redis.io/commands/json.arrlen
             */ arrlen: (...args)=>new JsonArrLenCommand(args, this.opts).exec(this.client),
            /**
             * @see https://redis.io/commands/json.arrpop
             */ arrpop: (...args)=>new JsonArrPopCommand(args, this.opts).exec(this.client),
            /**
             * @see https://redis.io/commands/json.arrtrim
             */ arrtrim: (...args)=>new JsonArrTrimCommand(args, this.opts).exec(this.client),
            /**
             * @see https://redis.io/commands/json.clear
             */ clear: (...args)=>new JsonClearCommand(args, this.opts).exec(this.client),
            /**
             * @see https://redis.io/commands/json.del
             */ del: (...args)=>new JsonDelCommand(args, this.opts).exec(this.client),
            /**
             * @see https://redis.io/commands/json.forget
             */ forget: (...args)=>new JsonForgetCommand(args, this.opts).exec(this.client),
            /**
             * @see https://redis.io/commands/json.get
             */ get: (...args)=>new JsonGetCommand(args, this.opts).exec(this.client),
            /**
             * @see https://redis.io/commands/json.mget
             */ mget: (...args)=>new JsonMGetCommand(args, this.opts).exec(this.client),
            /**
             * @see https://redis.io/commands/json.numincrby
             */ numincrby: (...args)=>new JsonNumIncrByCommand(args, this.opts).exec(this.client),
            /**
             * @see https://redis.io/commands/json.nummultby
             */ nummultby: (...args)=>new JsonNumMultByCommand(args, this.opts).exec(this.client),
            /**
             * @see https://redis.io/commands/json.objkeys
             */ objkeys: (...args)=>new JsonObjKeysCommand(args, this.opts).exec(this.client),
            /**
             * @see https://redis.io/commands/json.objlen
             */ objlen: (...args)=>new JsonObjLenCommand(args, this.opts).exec(this.client),
            /**
             * @see https://redis.io/commands/json.resp
             */ resp: (...args)=>new JsonRespCommand(args, this.opts).exec(this.client),
            /**
             * @see https://redis.io/commands/json.set
             */ set: (...args)=>new JsonSetCommand(args, this.opts).exec(this.client),
            /**
             * @see https://redis.io/commands/json.strappend
             */ strappend: (...args)=>new JsonStrAppendCommand(args, this.opts).exec(this.client),
            /**
             * @see https://redis.io/commands/json.strlen
             */ strlen: (...args)=>new JsonStrLenCommand(args, this.opts).exec(this.client),
            /**
             * @see https://redis.io/commands/json.toggle
             */ toggle: (...args)=>new JsonToggleCommand(args, this.opts).exec(this.client),
            /**
             * @see https://redis.io/commands/json.type
             */ type: (...args)=>new JsonTypeCommand(args, this.opts).exec(this.client)
        };
    }
    createScript(script) {
        return new Script(this, script);
    }
}

;// CONCATENATED MODULE: ./node_modules/.pnpm/@upstash+redis@1.21.0/node_modules/@upstash/redis/esm/pkg/http.js

class HttpClient {
    constructor(config){
        Object.defineProperty(this, "baseUrl", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        Object.defineProperty(this, "headers", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        Object.defineProperty(this, "options", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        Object.defineProperty(this, "retry", {
            enumerable: true,
            configurable: true,
            writable: true,
            value: void 0
        });
        this.options = {
            backend: config.options?.backend,
            agent: config.agent,
            responseEncoding: config.responseEncoding ?? "base64",
            cache: config.cache
        };
        this.baseUrl = config.baseUrl.replace(/\/$/, "");
        this.headers = {
            "Content-Type": "application/json",
            ...config.headers
        };
        if (this.options.responseEncoding === "base64") {
            this.headers["Upstash-Encoding"] = "base64";
        }
        if (typeof config?.retry === "boolean" && config?.retry === false) {
            this.retry = {
                attempts: 1,
                backoff: ()=>0
            };
        } else {
            this.retry = {
                attempts: config?.retry?.retries ?? 5,
                backoff: config?.retry?.backoff ?? ((retryCount)=>Math.exp(retryCount) * 50)
            };
        }
    }
    mergeTelemetry(telemetry) {
        function merge(obj, key, value) {
            if (!value) {
                return obj;
            }
            if (obj[key]) {
                obj[key] = [
                    obj[key],
                    value
                ].join(",");
            } else {
                obj[key] = value;
            }
            return obj;
        }
        this.headers = merge(this.headers, "Upstash-Telemetry-Runtime", telemetry.runtime);
        this.headers = merge(this.headers, "Upstash-Telemetry-Platform", telemetry.platform);
        this.headers = merge(this.headers, "Upstash-Telemetry-Sdk", telemetry.sdk);
    }
    async request(req) {
        const requestOptions = {
            cache: this.options.cache,
            method: "POST",
            headers: this.headers,
            body: JSON.stringify(req.body),
            keepalive: true,
            agent: this.options?.agent,
            /**
             * Fastly specific
             */ backend: this.options?.backend
        };
        let res = null;
        let error = null;
        for(let i = 0; i <= this.retry.attempts; i++){
            try {
                res = await fetch([
                    this.baseUrl,
                    ...req.path ?? []
                ].join("/"), requestOptions);
                break;
            } catch (err) {
                error = err;
                await new Promise((r)=>setTimeout(r, this.retry.backoff(i)));
            }
        }
        if (!res) {
            throw error ?? new Error("Exhausted all retries");
        }
        const body = await res.json();
        if (!res.ok) {
            throw new UpstashError(body.error);
        }
        if (this.options?.responseEncoding === "base64") {
            return Array.isArray(body) ? body.map(http_decode) : http_decode(body);
        }
        return body;
    }
}
function base64decode(b64) {
    let dec = "";
    try {
        /**
         * Using only atob() is not enough because it doesn't work with unicode characters
         */ const binString = atob(b64);
        const size = binString.length;
        const bytes = new Uint8Array(size);
        for(let i = 0; i < size; i++){
            bytes[i] = binString.charCodeAt(i);
        }
        dec = new TextDecoder().decode(bytes);
    } catch  {
        dec = b64;
    }
    return dec;
// try {
//   return decodeURIComponent(dec);
// } catch {
//   return dec;
// }
}
function http_decode(raw) {
    let result = undefined;
    switch(typeof raw.result){
        case "undefined":
            return raw;
        case "number":
            {
                result = raw.result;
                break;
            }
        case "object":
            {
                if (Array.isArray(raw.result)) {
                    result = raw.result.map((v)=>typeof v === "string" ? base64decode(v) : Array.isArray(v) ? v.map(base64decode) : v);
                } else {
                    // If it's not an array it must be null
                    // Apparently null is an object in javascript
                    result = null;
                }
                break;
            }
        case "string":
            {
                result = raw.result === "OK" ? "OK" : base64decode(raw.result);
                break;
            }
        default:
            break;
    }
    return {
        result,
        error: raw.error
    };
}

;// CONCATENATED MODULE: ./node_modules/.pnpm/@upstash+redis@1.21.0/node_modules/@upstash/redis/esm/version.js
const VERSION = "v1.21.0";

;// CONCATENATED MODULE: ./node_modules/.pnpm/@upstash+redis@1.21.0/node_modules/@upstash/redis/esm/platforms/nodejs.js
// deno-lint-ignore-file



/**
 * Workaround for nodejs 14, where atob is not included in the standardlib
 */ if (typeof atob === "undefined") {
    global.atob = function(b64) {
        return Buffer.from(b64, "base64").toString("utf-8");
    };
}
/**
 * Serverless redis client for upstash.
 */ class Redis extends redis_Redis {
    constructor(configOrRequester){
        if ("request" in configOrRequester) {
            super(configOrRequester);
            return;
        }
        if (configOrRequester.url.startsWith(" ") || configOrRequester.url.endsWith(" ") || /\r|\n/.test(configOrRequester.url)) {
            console.warn("The redis url contains whitespace or newline, which can cause errors!");
        }
        if (configOrRequester.token.startsWith(" ") || configOrRequester.token.endsWith(" ") || /\r|\n/.test(configOrRequester.token)) {
            console.warn("The redis token contains whitespace or newline, which can cause errors!");
        }
        const client = new HttpClient({
            baseUrl: configOrRequester.url,
            retry: configOrRequester.retry,
            headers: {
                authorization: `Bearer ${configOrRequester.token}`
            },
            agent: configOrRequester.agent,
            responseEncoding: configOrRequester.responseEncoding,
            cache: "no-store"
        });
        super(client, {
            automaticDeserialization: configOrRequester.automaticDeserialization,
            enableTelemetry: !process.env.UPSTASH_DISABLE_TELEMETRY
        });
        this.addTelemetry({
            runtime: typeof EdgeRuntime === "string" ? "edge-light" : `node@${process.version}`,
            platform: process.env.VERCEL ? "vercel" : process.env.AWS_REGION ? "aws" : "unknown",
            sdk: `@upstash/redis@${VERSION}`
        });
    }
    /**
     * Create a new Upstash Redis instance from environment variables.
     *
     * Use this to automatically load connection secrets from your environment
     * variables. For instance when using the Vercel integration.
     *
     * This tries to load `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` from
     * your environment using `process.env`.
     */ static fromEnv(config) {
        // @ts-ignore process will be defined in node
        if (typeof process?.env === "undefined") {
            throw new Error('Unable to get environment variables, `process.env` is undefined. If you are deploying to cloudflare, please import from "@upstash/redis/cloudflare" instead');
        }
        // @ts-ignore process will be defined in node
        const url = process?.env["UPSTASH_REDIS_REST_URL"];
        if (!url) {
            throw new Error("Unable to find environment variable: `UPSTASH_REDIS_REST_URL`");
        }
        // @ts-ignore process will be defined in node
        const token = process?.env["UPSTASH_REDIS_REST_TOKEN"];
        if (!token) {
            throw new Error("Unable to find environment variable: `UPSTASH_REDIS_REST_TOKEN`");
        }
        return new Redis({
            ...config,
            url,
            token
        });
    }
}


/***/ })

};
;