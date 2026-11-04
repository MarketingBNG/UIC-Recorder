package com.usaindiacfo.uicrecorder.ui

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Call
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.Person
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.Icon
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.PrimaryTabRow
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Tab
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.NavGraph.Companion.findStartDestination
import androidx.navigation.NavHostController
import androidx.navigation.NavType
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController
import androidx.navigation.navArgument
import com.usaindiacfo.uicrecorder.AppContainer
import com.usaindiacfo.uicrecorder.data.api.UserDto
import com.usaindiacfo.uicrecorder.ui.admin.DevicesScreen
import com.usaindiacfo.uicrecorder.ui.admin.FirefliesBanner
import com.usaindiacfo.uicrecorder.ui.admin.ServerSettingsScreen
import com.usaindiacfo.uicrecorder.ui.admin.UsersScreen
import com.usaindiacfo.uicrecorder.ui.calls.CallDetailScreen
import com.usaindiacfo.uicrecorder.ui.calls.CallsScreen
import com.usaindiacfo.uicrecorder.ui.home.HomeScreen
import com.usaindiacfo.uicrecorder.ui.settings.SettingsScreen
import com.usaindiacfo.uicrecorder.ui.setup.SetupScreen
import com.usaindiacfo.uicrecorder.ui.signin.SignInScreen

object Routes {
    const val SIGN_IN = "signIn"
    const val SETUP = "setup"
    const val HOME = "home"
    const val CALLS = "calls"
    const val CALL_DETAIL = "callDetail/{id}"
    const val ADMIN_USERS = "admin/users"
    const val ADMIN_DEVICES = "admin/devices"
    const val ADMIN_SETTINGS = "admin/settings"
    const val SETTINGS = "settings"

    fun callDetail(id: String) = "callDetail/$id"
}

private data class Tab(val route: String, val label: String, val icon: ImageVector)

private val ADMIN_ROUTES = listOf(Routes.ADMIN_USERS, Routes.ADMIN_DEVICES, Routes.ADMIN_SETTINGS)

@Composable
fun AppNavigation(container: AppContainer, nav: NavHostController = rememberNavController()) {
    val user by container.authRepository.currentUser.collectAsStateWithLifecycle()
    val entry by nav.currentBackStackEntryAsState()
    val route = entry?.destination?.route
    val start = remember { if (user == null) Routes.SIGN_IN else Routes.HOME }

    // Signed out (button, or refresh token rejected): back to sign-in with a clean back stack.
    LaunchedEffect(user == null) {
        if (user == null && route != null && route != Routes.SIGN_IN) {
            nav.navigate(Routes.SIGN_IN) { popUpTo(0) { inclusive = true } }
        }
    }

    val tabs = buildList {
        add(Tab(Routes.HOME, "Home", Icons.Filled.Home))
        add(Tab(Routes.CALLS, "Calls", Icons.Filled.Call))
        if (user?.canManage == true) add(Tab(Routes.ADMIN_USERS, "Admin", Icons.Filled.Person))
        add(Tab(Routes.SETTINGS, "Settings", Icons.Filled.Settings))
    }
    val showBar = route != null && route != Routes.SIGN_IN && route != Routes.SETUP

    Scaffold(
        bottomBar = {
            if (showBar) NavigationBar {
                tabs.forEach { tab ->
                    val selected = route == tab.route || (tab.route == Routes.ADMIN_USERS && route in ADMIN_ROUTES) ||
                        (tab.route == Routes.CALLS && route == Routes.CALL_DETAIL)
                    NavigationBarItem(
                        selected = selected,
                        onClick = { nav.navigateTab(tab.route) },
                        icon = { Icon(tab.icon, contentDescription = null) },
                        label = { Text(tab.label) },
                    )
                }
            }
        },
    ) { padding ->
        NavHost(
            navController = nav,
            startDestination = start,
            modifier = Modifier.padding(padding),
        ) {
            composable(Routes.SIGN_IN) {
                SignInScreen(onSignedIn = {
                    nav.navigate(Routes.SETUP) { popUpTo(Routes.SIGN_IN) { inclusive = true } }
                })
            }
            composable(Routes.SETUP) {
                SetupScreen(onDone = {
                    nav.navigate(Routes.HOME) { popUpTo(Routes.SETUP) { inclusive = true } }
                })
            }
            composable(Routes.HOME) { HomeScreen(onOpenSetup = { nav.navigate(Routes.SETUP) }) }
            composable(Routes.CALLS) { CallsScreen(onOpenCall = { nav.navigate(Routes.callDetail(it)) }) }
            composable(Routes.CALL_DETAIL, arguments = listOf(navArgument("id") { type = NavType.StringType })) {
                CallDetailScreen(id = it.arguments?.getString("id").orEmpty(), onBack = { nav.popBackStack() })
            }
            composable(Routes.ADMIN_USERS) { AdminTabs(user, route, nav) { UsersScreen() } }
            composable(Routes.ADMIN_DEVICES) { AdminTabs(user, route, nav) { DevicesScreen() } }
            composable(Routes.ADMIN_SETTINGS) { AdminTabs(user, route, nav) { ServerSettingsScreen() } }
            composable(Routes.SETTINGS) { SettingsScreen(onOpenSetup = { nav.navigate(Routes.SETUP) }) }
        }
    }
}

/** Users / Devices for managers and admins; Server settings for admins only (server enforces too). */
@Composable
private fun AdminTabs(user: UserDto?, route: String?, nav: NavHostController, content: @Composable () -> Unit) {
    val items = buildList {
        add(Routes.ADMIN_USERS to "Users")
        add(Routes.ADMIN_DEVICES to "Devices")
        if (user?.isAdmin == true) add(Routes.ADMIN_SETTINGS to "Server")
    }
    Column(Modifier.fillMaxSize()) {
        PrimaryTabRow(selectedTabIndex = items.indexOfFirst { it.first == route }.coerceAtLeast(0)) {
            items.forEach { (r, label) ->
                Tab(selected = r == route, onClick = { if (r != route) nav.navigateTab(r) }, text = { Text(label) })
            }
        }
        FirefliesBanner(route, user?.id, fetch = route != Routes.ADMIN_DEVICES) // Devices fetches with its panel
        content()
    }
}

private fun NavHostController.navigateTab(route: String) = navigate(route) {
    popUpTo(graph.findStartDestination().id) { saveState = true }
    launchSingleTop = true
    restoreState = true
}
