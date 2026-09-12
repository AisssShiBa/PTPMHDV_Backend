package com.ptpmhdv.userservice.dto;

import jakarta.validation.constraints.NotBlank;
import lombok.Data;

@Data
public class KycSubmitRequest {

    @NotBlank(message = "idNumber is required")
    private String idNumber;

    @NotBlank(message = "idImageUrl is required")
    private String idImageUrl;
}
