package org.subetha.sample.doorbell

import android.Manifest
import android.content.pm.PackageManager
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import java.text.DateFormat
import java.util.Date

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            MaterialTheme(colorScheme = if (isSystemInDarkTheme()) darkColorScheme() else lightColorScheme()) {
                App()
            }
        }
    }
}

@Composable
fun App(vm: DoorbellViewModel = viewModel()) {
    var tab by remember { mutableIntStateOf(0) }
    Scaffold(
        bottomBar = {
            NavigationBar {
                NavigationBarItem(selected = tab == 0, onClick = { tab = 0 }, icon = {}, label = { Text("Doorbell") })
                NavigationBarItem(selected = tab == 1, onClick = { tab = 1 }, icon = {}, label = { Text("Edge") })
            }
        },
    ) { padding ->
        Column(Modifier.padding(padding).padding(16.dp).fillMaxSize()) {
            if (tab == 0) DoorbellScreen(vm) else EdgeScreen()
        }
    }
}

@Composable
fun DoorbellScreen(vm: DoorbellViewModel) {
    val s by vm.state.collectAsStateWithLifecycle()
    Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
        if (!s.connected) {
            OutlinedTextField(s.token, { vm.edit(token = it) }, Modifier.fillMaxWidth(), label = { Text("Token") },
                visualTransformation = PasswordVisualTransformation(), singleLine = true)
            OutlinedTextField(s.topic, { vm.edit(topic = it) }, Modifier.fillMaxWidth(), label = { Text("Topic") }, singleLine = true)
            OutlinedTextField(s.baseUrl, { vm.edit(baseUrl = it) }, Modifier.fillMaxWidth(), label = { Text("Base URL") }, singleLine = true)
            Button(onClick = vm::connect, enabled = s.token.isNotBlank() && s.topic.isNotBlank()) { Text("Subscribe") }
        } else {
            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                Button(onClick = vm::ring, enabled = !s.busy) { Text("Ring \"ding\"") }
                OutlinedButton(onClick = vm::estimate, enabled = !s.busy) { Text("Route & cost") }
                OutlinedButton(onClick = vm::disconnect) { Text("Disconnect") }
            }
        }
        Text(s.status, style = MaterialTheme.typography.bodySmall)
        s.estimate?.let { Card(Modifier.fillMaxWidth()) { Text(it, Modifier.padding(12.dp), style = MaterialTheme.typography.bodySmall) } }
        Text("Inbox", style = MaterialTheme.typography.titleMedium)
        LazyColumn(verticalArrangement = Arrangement.spacedBy(4.dp)) {
            items(s.inbox, key = { it.id ?: it.hashCode().toString() }) { m ->
                val time = m.time?.let { DateFormat.getTimeInstance().format(Date(it * 1000)) } ?: ""
                Text("$time  ${m.title?.let { "$it: " } ?: ""}${m.message ?: ""}")
            }
        }
    }
}

@Composable
fun EdgeScreen(vm: EdgeViewModel = viewModel()) {
    val s by vm.state.collectAsStateWithLifecycle()
    val context = LocalContext.current
    var text by remember { mutableStateOf("Ding dong") }
    val askMic = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) vm.toggleListening()
    }
    Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
        Text("Edge: sound", style = MaterialTheme.typography.titleLarge)
        if (!s.coreAvailable) {
            Text(
                "libsubetha_core.so isn't bundled in this build. Build it with cargo-ndk into " +
                    "app/src/main/jniLibs (see samples/android/README.md) to send messages by sound.",
                style = MaterialTheme.typography.bodySmall,
            )
            return@Column
        }
        Text(
            "Two phones, no network: one plays a message as a 16-FSK modem frame, the other listens " +
                "and decodes it (about 50 bytes a second). Same topic on both.",
            style = MaterialTheme.typography.bodySmall,
        )
        OutlinedTextField(s.topic, vm::editTopic, Modifier.fillMaxWidth(), label = { Text("Topic") }, singleLine = true)
        OutlinedTextField(text, { text = it }, Modifier.fillMaxWidth(), label = { Text("Message") }, singleLine = true)
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(onClick = { vm.send(text) }, enabled = !s.sending && text.isNotBlank()) { Text("Send by sound") }
            OutlinedButton(onClick = {
                val granted = ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
                if (granted || s.listening) vm.toggleListening() else askMic.launch(Manifest.permission.RECORD_AUDIO)
            }) { Text(if (s.listening) "Stop listening" else "Listen") }
        }
        if (s.status.isNotEmpty()) Text(s.status, style = MaterialTheme.typography.bodySmall)
        LazyColumn(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            items(s.heard) { m -> Card(Modifier.fillMaxWidth()) { Text(m, Modifier.padding(12.dp)) } }
        }
        Spacer(Modifier)
    }
}
