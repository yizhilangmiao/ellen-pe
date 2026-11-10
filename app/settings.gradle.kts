pluginManagement {
    repositories {
        maven("https://maven.aliyun.com/repository/gradle-plugin")
        gradlePluginPortal()
        google()
        mavenCentral()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        // 不用阿里云 public 镜像：它只镜像了 com.capacitorjs 的 pom，aar 是 404，
        // 而 Gradle 会把「元数据找到了但制品缺失」当成本仓失败，不会自动换下一个仓。
        google()
        mavenCentral()
    }
}

rootProject.name = "ellen-mobile-2"
include(":app")
