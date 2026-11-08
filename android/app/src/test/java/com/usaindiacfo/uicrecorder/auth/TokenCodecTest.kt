package com.usaindiacfo.uicrecorder.auth

import com.google.crypto.tink.Aead
import com.google.crypto.tink.KeyTemplates
import com.google.crypto.tink.KeysetHandle
import com.google.crypto.tink.RegistryConfiguration
import com.google.crypto.tink.aead.AeadConfig
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Test

class TokenCodecTest {
    private fun aead(): Aead {
        AeadConfig.register()
        return KeysetHandle.generateNew(KeyTemplates.get("AES256_GCM")).getPrimitive(RegistryConfiguration.get(), Aead::class.java)
    }

    @Test fun roundTripsAndHidesTokens() {
        val codec = TokenCodec(aead())
        val t = StoredTokens("install-1", "acc", "ref-secret", 123L, """{"id":"u"}""")
        val blob = codec.encode(t)
        assertFalse(blob.contains("ref-secret"))
        assertEquals(t, codec.decode(blob))
    }

    @Test fun otherKeyOrGarbageDecodesToNull() {
        val blob = TokenCodec(aead()).encode(StoredTokens("i"))
        assertNull(TokenCodec(aead()).decode(blob))
        assertNull(TokenCodec(aead()).decode("not base64 !!"))
    }
}
