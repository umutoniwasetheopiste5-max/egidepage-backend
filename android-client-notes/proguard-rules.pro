# Protection #4: code obfuscation.
# Add/merge into your app module's proguard-rules.pro, and make sure your
# build.gradle release buildType has:
#   minifyEnabled true
#   shrinkResources true
#   proguardFiles getDefaultProguardFile('proguard-android-optimize.txt'), 'proguard-rules.pro'
#
# This alone turns your class/method names into the same kind of garbled
# single/double-letter names (a9.b3, jd.n, etc.) we had to wade through
# decompiling cricmad and CRICFy. It won't stop a determined reverse
# engineer, but it stops casual copy-paste cloning.

# Keep your app's actual entry points (adjust package name) so the app still
# runs correctly - obfuscate everything else.
-keep class com.egidepage.tv.MainActivity { *; }
-keep class com.egidepage.tv.App { *; }

# If you use Retrofit/Gson/OkHttp (recommended for talking to the backend),
# keep their required annotations/attributes:
-keepattributes Signature, *Annotation*, InnerClasses, EnclosingMethod
-keepclassmembers,allowobfuscation class * {
  @com.google.gson.annotations.SerializedName <fields>;
}

# Don't log anything in release builds - another thing cricmad was sloppy
# about in places; stripped logs = less for a sniffer/decompiler to read.
-assumenosideeffects class android.util.Log {
    public static *** d(...);
    public static *** v(...);
    public static *** i(...);
}
