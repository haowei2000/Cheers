package com.cheers.android.data.auth

import okhttp3.Interceptor
import okhttp3.RequestBody
import okhttp3.Response
import okio.BufferedSink

/** Also prevents OkHttp's HTTP 503/421 follow-ups from replaying a write body. */
class WriteOnceInterceptor : Interceptor {
    override fun intercept(chain: Interceptor.Chain): Response {
        val request = chain.request()
        val body = request.body
        if (request.method == "GET" || request.method == "HEAD" || body == null || body.isOneShot()) {
            return chain.proceed(request)
        }
        val oneShot = object : RequestBody() {
            override fun contentType() = body.contentType()
            override fun contentLength() = body.contentLength()
            override fun isOneShot() = true
            override fun isDuplex() = body.isDuplex()
            override fun writeTo(sink: BufferedSink) = body.writeTo(sink)
        }
        return chain.proceed(request.newBuilder().method(request.method, oneShot).build())
    }
}
